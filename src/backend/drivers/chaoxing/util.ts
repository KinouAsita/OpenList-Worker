// ChaoXing (超星小组网盘) API 客户端
import {
  DriverChaoXingAddition,
  ChaoXingFile,
  ChaoXingLoginResp,
  ChaoXingListResp,
  ChaoXingDownResp,
  ChaoXingUploadConfigResp,
  ChaoXingUploadFileResp,
} from "./types"
import { aesCbcEncryptBase64 } from "../../pkg/crypto"

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.4-b478491100 Safari/537.36 Channel/pckk_other_ch"
const REFERER = "https://chaoxing.com/"
const API = "https://groupweb.chaoxing.com"
const DOWNLOAD_API = "https://noteyd.chaoxing.com"
const LOGIN_KEY = "u2oh6Vu^HWe4_AES"

/**
 * 解析超星 API 返回的时间字段为 ISO 字符串。
 *
 * 支持：
 *   1. 数字毫秒时间戳：1780191356415
 *   2. 数字字符串时间戳："1780191356415"（手机端上传）
 *   3. 日期字符串："2024-11-06 07:49" / "2024-11-06 07:49:30"
 *   4. ISO 日期字符串
 * 无效值兜底返回当前时间，避免 RangeError 中断列表渲染。
 */
export function parseChaoXingTimestamp(
  raw: number | string | undefined,
): string {
  if (raw === undefined || raw === null || raw === "") {
    return new Date().toISOString()
  }
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0
      ? new Date(raw).toISOString()
      : new Date().toISOString()
  }
  const trimmed = String(raw).trim()
  if (!trimmed) {
    return new Date().toISOString()
  }
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed)
    return Number.isFinite(ms) && ms > 0
      ? new Date(ms).toISOString()
      : new Date().toISOString()
  }
  const dateMatch = trimmed.match(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/,
  )
  if (dateMatch) {
    const parsed = new Date(
      `${dateMatch[1]}T${dateMatch[2]}:${dateMatch[3] || "00"}Z`,
    )
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString()
    }
  }
  const parsed = new Date(trimmed)
  return Number.isNaN(parsed.getTime())
    ? new Date().toISOString()
    : parsed.toISOString()
}

/**
 * 从 Fetch Response Headers 提取所有 Set-Cookie 的 name=value 片段。
 * 优先使用 getSetCookie()；不支持时按新 cookie 起始模式拆分合并后的 set-cookie。
 */
export function extractSetCookies(headers: Headers): string[] {
  const cookies: string[] = []
  const setCookies =
    typeof (headers as any).getSetCookie === "function"
      ? (headers as any).getSetCookie()
      : []
  if (Array.isArray(setCookies) && setCookies.length > 0) {
    for (const sc of setCookies) {
      const pair = String(sc || "")
        .split(";")[0]
        .trim()
      if (pair) cookies.push(pair)
    }
    return cookies
  }
  const combined = headers.get("set-cookie")
  if (!combined) return cookies
  for (const part of combined.split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/g)) {
    const pair = part.split(";")[0].trim()
    if (pair) cookies.push(pair)
  }
  return cookies
}

export class ClientChaoXing {
  private addition: DriverChaoXingAddition
  private cookie: string
  private persistCookie?: (cookie: string) => void | Promise<void>
  private reloginPromise: Promise<void> | null = null

  constructor(
    addition: DriverChaoXingAddition,
    persistCookie?: (cookie: string) => void | Promise<void>,
  ) {
    this.addition = addition
    this.cookie = addition.cookie || ""
    this.persistCookie = persistCookie
  }

  async init(): Promise<void> {
    if (!this.addition.bbsid) {
      throw new Error("[ChaoXing] bbsid is required")
    }
    if (!this.cookie) {
      this.cookie = await this.login()
      if (this.persistCookie) await this.persistCookie(this.cookie)
    }
  }

  getCookie(): string {
    return this.cookie
  }

  downloadHeaders(): Record<string, string> {
    return {
      Cookie: this.cookie,
      Referer: REFERER,
      "User-Agent": UA,
    }
  }

  private canRelogin(): boolean {
    return Boolean(this.addition.user_name && this.addition.password)
  }

  private async relogin(): Promise<void> {
    if (!this.reloginPromise) {
      this.reloginPromise = (async () => {
        const nextCookie = await this.login()
        this.cookie = nextCookie
        if (this.persistCookie) {
          await this.persistCookie(nextCookie)
        }
      })().finally(() => {
        this.reloginPromise = null
      })
    }
    await this.reloginPromise
  }

  async login(): Promise<string> {
    if (!this.addition.user_name || !this.addition.password) {
      throw new Error("[ChaoXing] user_name and password are required")
    }
    const uname = await aesCbcEncryptBase64(this.addition.user_name, LOGIN_KEY)
    const password = await aesCbcEncryptBase64(
      this.addition.password,
      LOGIN_KEY,
    )
    const fd = new FormData()
    fd.append("uname", uname)
    fd.append("password", password)
    fd.append("t", "true")
    const resp = await fetch("https://passport2.chaoxing.com/fanyalogin", {
      method: "POST",
      body: fd,
    })
    if (resp.status >= 400) {
      throw new Error(`[ChaoXing] login failed: HTTP ${resp.status}`)
    }
    const text = await resp.text()
    if (text.trim().startsWith("{")) {
      try {
        const body = JSON.parse(text) as ChaoXingLoginResp
        if (body.status === false) {
          throw new Error(
            `[ChaoXing] login failed: ${body.msg2 || body.mes || "invalid credentials"}`,
          )
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("[ChaoXing]")) {
          throw err
        }
      }
    }
    const cookies = extractSetCookies(resp.headers)
    if (cookies.length === 0) {
      throw new Error("[ChaoXing] login failed: no cookie returned")
    }
    return cookies.join("; ")
  }

  private async fetchJson<T = any>(
    url: string,
    method: string,
    buildHeaders: () => Record<string, string>,
    errPrefix: string,
    allowRetry = true,
  ): Promise<T> {
    const resp = await fetch(url, {
      method,
      headers: buildHeaders(),
      redirect: "manual",
    })
    if (
      resp.status === 401 ||
      resp.status === 403 ||
      (resp.status >= 300 && resp.status < 400)
    ) {
      if (allowRetry && this.canRelogin()) {
        await this.relogin()
        return this.fetchJson<T>(url, method, buildHeaders, errPrefix, false)
      }
      throw new Error(`${errPrefix}: HTTP ${resp.status}`)
    }
    if (resp.status >= 400) {
      throw new Error(`${errPrefix}: HTTP ${resp.status}`)
    }
    const text = await resp.text()
    try {
      return JSON.parse(text) as T
    } catch {
      if (allowRetry && this.canRelogin()) {
        await this.relogin()
        return this.fetchJson<T>(url, method, buildHeaders, errPrefix, false)
      }
      throw new Error(`${errPrefix}: invalid JSON response`)
    }
  }

  private async request<T = any>(
    pathname: string,
    method: string,
    query?: Record<string, string>,
    extraHeaders?: Record<string, string>,
    allowRetry = true,
  ): Promise<T> {
    const qs = query ? "?" + new URLSearchParams(query).toString() : ""
    return this.fetchJson<T>(
      `${API}${pathname}${qs}`,
      method,
      () => ({
        Cookie: this.cookie,
        Accept: "application/json, text/plain, */*",
        Referer: REFERER,
        ...extraHeaders,
      }),
      "[ChaoXing] request failed",
      allowRetry,
    )
  }

  private async requestDownload<T = any>(
    pathname: string,
    method: string,
    allowRetry = true,
  ): Promise<T> {
    return this.fetchJson<T>(
      `${DOWNLOAD_API}${pathname}`,
      method,
      () => ({
        Cookie: this.cookie,
        Accept: "application/json, text/plain, */*",
        Referer: REFERER,
        "User-Agent": UA,
      }),
      "[ChaoXing] download request failed",
      allowRetry,
    )
  }

  async getFiles(parent: string): Promise<ChaoXingFile[]> {
    const files: ChaoXingFile[] = []

    let resp = await this.request<ChaoXingListResp>(
      "/pc/resource/getResourceList",
      "GET",
      { bbsid: this.addition.bbsid, folderId: parent, recType: "1" },
    )
    if (resp.result !== 1 && this.canRelogin()) {
      await this.relogin()
      resp = await this.request<ChaoXingListResp>(
        "/pc/resource/getResourceList",
        "GET",
        { bbsid: this.addition.bbsid, folderId: parent, recType: "1" },
        undefined,
        false,
      )
    }
    if (resp.result !== 1) {
      throw new Error(`[ChaoXing] list failed: result=${resp.result}`)
    }
    if (resp.list && resp.list.length > 0) {
      files.push(...resp.list)
    }

    const resps = await this.request<ChaoXingListResp>(
      "/pc/resource/getResourceList",
      "GET",
      { bbsid: this.addition.bbsid, folderId: parent, recType: "2" },
    )
    for (const file of resps.list || []) {
      // 手机端超星上传的文件没有 fileId 字段，但 objectId 与 fileId 相同，可代替
      if (!file.content.fileId) {
        file.content.fileId = file.content.objectId || ""
      }
      files.push(file)
    }
    return files
  }

  async link(fileId: string): Promise<ChaoXingDownResp> {
    const resp = await this.requestDownload<ChaoXingDownResp>(
      "/screen/note_note/files/status/" + fileId,
      "POST",
    )
    if (!resp.download) {
      throw new Error(
        `[ChaoXing] link failed: ${resp.msg || "no download url"}`,
      )
    }
    return resp
  }

  async mkdir(parentId: string, name: string): Promise<void> {
    const resp = await this.request<ChaoXingListResp>(
      "/pc/resource/addResourceFolder",
      "GET",
      { bbsid: this.addition.bbsid, name, pid: parentId },
    )
    if (resp.result !== 1) {
      throw new Error(`[ChaoXing] mkdir failed: ${resp.msg}`)
    }
  }

  async move(id: string, dstId: string, isDir: boolean): Promise<void> {
    const query: Record<string, string> = isDir
      ? { bbsid: this.addition.bbsid, folderIds: id, targetId: dstId }
      : { bbsid: this.addition.bbsid, recIds: id, targetId: dstId }
    const resp = await this.request<ChaoXingListResp>(
      "/pc/resource/moveResource",
      "GET",
      query,
    )
    if (!resp.status) {
      throw new Error(`[ChaoXing] move failed: ${resp.msg}`)
    }
  }

  async renameFolder(folderId: string, newName: string): Promise<void> {
    const resp = await this.request<ChaoXingListResp>(
      "/pc/resource/updateResourceFolderName",
      "GET",
      { bbsid: this.addition.bbsid, folderId, name: newName },
    )
    if (resp.result !== 1) {
      throw new Error(`[ChaoXing] rename failed: ${resp.msg}`)
    }
  }

  async remove(id: string, isDir: boolean): Promise<void> {
    const path = isDir
      ? "/pc/resource/deleteResourceFolder"
      : "/pc/resource/deleteResourceFile"
    const query: Record<string, string> = isDir
      ? { bbsid: this.addition.bbsid, folderIds: id }
      : { bbsid: this.addition.bbsid, recIds: id }
    const resp = await this.request<ChaoXingListResp>(path, "GET", query)
    if (resp.result !== 1) {
      throw new Error(`[ChaoXing] remove failed: ${resp.msg}`)
    }
  }

  async upload(
    parentId: string,
    name: string,
    content: Uint8Array,
  ): Promise<void> {
    // 1. 获取上传配置（token / puid）—— 必须携带认证 Cookie 与 Referer
    let cfg = await this.requestDownload<ChaoXingUploadConfigResp>(
      "/pc/files/getUploadConfig",
      "GET",
    )
    if ((cfg.result !== 1 || !cfg.msg?.token) && this.canRelogin()) {
      await this.relogin()
      cfg = await this.requestDownload<ChaoXingUploadConfigResp>(
        "/pc/files/getUploadConfig",
        "GET",
        false,
      )
    }
    if (cfg.result !== 1 || !cfg.msg?.token) {
      throw new Error("[ChaoXing] get upload config failed")
    }

    // 2. multipart 上传文件
    const fd = new FormData()
    const buf = content.buffer.slice(
      content.byteOffset,
      content.byteOffset + content.byteLength,
    ) as ArrayBuffer
    fd.append("file", new Blob([buf]), name)
    fd.append("_token", cfg.msg.token)
    fd.append("puid", String(cfg.msg.puid || ""))
    const upResp = await fetch("https://pan-yz.chaoxing.com/upload", {
      method: "POST",
      headers: {
        Referer: REFERER,
        "User-Agent": UA,
      },
      body: fd,
    })
    if (upResp.status >= 400) {
      throw new Error(`[ChaoXing] upload failed: HTTP ${upResp.status}`)
    }
    const fileRsp = (await upResp.json()) as ChaoXingUploadFileResp
    if (fileRsp.msg !== "success" || !fileRsp.objectId) {
      throw new Error(`[ChaoXing] upload failed: ${fileRsp.msg}`)
    }

    // 3. 登记文件到小组网盘
    const param = {
      cataid: "100000019",
      key: fileRsp.objectId,
      param: fileRsp.data || {},
    }
    const params = JSON.stringify(param)
    const resp = await this.request<ChaoXingListResp>(
      "/pc/resource/addResource",
      "GET",
      {
        bbsid: this.addition.bbsid,
        pid: parentId,
        type: "yunpan",
        params: encodeURIComponent("[" + params + "]"),
      },
    )
    if (resp.result !== 1) {
      throw new Error(`[ChaoXing] add resource failed: ${resp.msg}`)
    }
  }
}
