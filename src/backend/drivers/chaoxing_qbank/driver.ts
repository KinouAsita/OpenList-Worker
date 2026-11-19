import {
  StorageDriver,
  FileItem,
  calcFileType,
} from "../../internal/driver/base"
import { parseChaoXingTimestamp } from "../chaoxing/util"
import { DriverChaoXingQBankAddition, QBankRelationItem } from "./types"
import { ClientChaoXingQBank, parseQuestionFileMeta } from "./util"

function relationToItem(it: QBankRelationItem): FileItem | null {
  if (it.id > 0 && !it.questionBank) {
    const name = (it.dirName || "").trim()
    if (!name) return null
    return {
      name,
      size: 0,
      is_dir: true,
      modified: parseChaoXingTimestamp(it.lastUpdateTime || it.createTime),
      sign: String(it.id),
      type: 1,
    }
  }
  if (it.questionBank) {
    const meta = parseQuestionFileMeta(it.questionBank.content || "")
    if (!meta) return null
    return {
      name: meta.name,
      size: meta.size,
      is_dir: false,
      modified: parseChaoXingTimestamp(
        it.questionBank.lastUpdateTime || it.questionBank.createTime,
      ),
      sign: `${it.questionBank.id}$${meta.objectId}$${meta.size}`,
      type: calcFileType(meta.name, false),
      raw_url: "",
    }
  }
  return null
}

export class DriverChaoXingQBank implements StorageDriver {
  private addition: DriverChaoXingQBankAddition
  private client: ClientChaoXingQBank
  private pathCache = new Map<string, string>()

  constructor(
    addition: DriverChaoXingQBankAddition,
    persistCookie?: (cookie: string) => void | Promise<void>,
  ) {
    this.addition = addition
    this.client = new ClientChaoXingQBank(addition, persistCookie)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  private getRootId(): string {
    const raw = String(this.addition.root_dir_id ?? "").trim()
    return raw && raw !== "/" ? raw : "0"
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const dirId = await this.pathToId(physicalPath)
    const items = await this.client.searchAll(dirId)
    const out: FileItem[] = []
    for (const it of items) {
      const mapped = relationToItem(it)
      if (mapped) out.push(mapped)
    }
    return out
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const parts = physicalPath.split("/").filter(Boolean)
    const rawName = parts[parts.length - 1] || "root"
    const parentPath = "/" + parts.slice(0, -1).join("/")

    try {
      const items = await this.list("", parentPath)
      const target = items.find((i) => i.name === rawName)
      if (target) {
        if (!target.is_dir) {
          const objId = target.sign.split("$")[1] || ""
          if (objId) {
            try {
              target.raw_url = await this.client.resolveDownloadUrl(objId)
              target.raw_url_headers = this.client.downloadHeaders()
            } catch {
              target.raw_url_error =
                "[ChaoXingQBank] failed to resolve download url"
            }
          }
        }
        return target
      }
    } catch {
      // fall through
    }

    try {
      const dirId = await this.pathToId(physicalPath)
      return {
        name: rawName,
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: dirId,
        type: 1,
        raw_url: "",
      }
    } catch {
      return {
        name: rawName,
        size: 0,
        is_dir: false,
        modified: new Date().toISOString(),
        sign: "",
        type: 0,
        raw_url: "",
      }
    }
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts.pop() || "new_folder"
    const parentPath = "/" + parts.join("/")
    const parentId = await this.pathToId(parentPath)
    await this.client.insertDir(parentId, name)
    this.pathCache.clear()
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const entry = await this.resolveEntry(physicalPath)
    if (entry.isDir) {
      await this.client.renameDir(entry.id, entry.parentId, newName)
    } else {
      await this.client.saveQuestionFile(
        entry.parentId,
        entry.id,
        newName,
        entry.objectId,
        entry.size,
      )
    }
    this.pathCache.clear()
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const entry = await this.resolveEntry(physicalPath)
    await this.client.deleteItem(entry.id, entry.isDir)
    this.pathCache.clear()
  }

  async move(
    _srcDir: string,
    _dstDir: string,
    _names: string[],
    srcPhysical: string,
    dstPhysical: string,
  ): Promise<void> {
    const entry = await this.resolveEntry(srcPhysical)
    const dstParts = dstPhysical.split("/").filter(Boolean)
    const dstName = dstParts.pop() || entry.name
    const dstParentPath = "/" + dstParts.join("/")
    const dstParentId = await this.pathToId(dstParentPath)
    await this.client.moveItem(entry.id, dstParentId, entry.isDir)
    if (dstName !== entry.name) {
      if (entry.isDir) {
        await this.client.renameDir(entry.id, dstParentId, dstName)
      } else {
        await this.client.saveQuestionFile(
          dstParentId,
          entry.id,
          dstName,
          entry.objectId,
          entry.size,
        )
      }
    }
    this.pathCache.clear()
  }

  async copy(): Promise<void> {
    throw new Error("[ChaoXingQBank] copy not supported")
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Uint8Array,
  ): Promise<void> {
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts.pop() || "file"
    const parentPath = "/" + parts.join("/")
    const parentId = await this.pathToId(parentPath)
    const objId = await this.client.uploadAttachment(parentId, name, content)
    await this.client.saveQuestionFile(parentId, "", name, objId, content.byteLength)
    this.pathCache.clear()
  }

  private async resolveEntry(physicalPath: string): Promise<{
    id: string
    parentId: string
    name: string
    isDir: boolean
    objectId: string
    size: number
  }> {
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts[parts.length - 1]
    const parentPath = "/" + parts.slice(0, -1).join("/")
    const parentId = await this.pathToId(parentPath)
    const items = await this.list("", parentPath)
    const target = items.find((i) => i.name === name)
    if (!target) throw new Error(`[ChaoXingQBank] '${name}' not found`)
    if (target.is_dir) {
      return {
        id: target.sign,
        parentId,
        name: target.name,
        isDir: true,
        objectId: "",
        size: 0,
      }
    }
    const [qid, objId = ""] = target.sign.split("$")
    return {
      id: qid,
      parentId,
      name: target.name,
      isDir: false,
      objectId: objId,
      size: target.size,
    }
  }

  private async pathToId(physicalPath: string): Promise<string> {
    const parts = physicalPath.split("/").filter(Boolean)
    if (parts.length === 0) return this.getRootId()
    const normalized = "/" + parts.join("/")
    const cached = this.pathCache.get(normalized)
    if (cached) return cached

    let currentId = this.getRootId()
    for (let i = 0; i < parts.length; i++) {
      const subPath = "/" + parts.slice(0, i + 1).join("/")
      const subCached = this.pathCache.get(subPath)
      if (subCached) {
        currentId = subCached
        continue
      }
      const items = await this.client.searchAll(currentId)
      const target = items.find(
        (it) => it.id > 0 && !it.questionBank && (it.dirName || "").trim() === parts[i],
      )
      if (!target) {
        throw new Error(`[ChaoXingQBank] Directory '${parts[i]}' not found`)
      }
      currentId = String(target.id)
      this.pathCache.set(subPath, currentId)
    }
    return currentId
  }
}
