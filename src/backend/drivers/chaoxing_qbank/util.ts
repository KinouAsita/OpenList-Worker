import { aesCbcEncryptBase64 } from "../../pkg/crypto"
import { extractSetCookies } from "../chaoxing/util"
import {
  DriverChaoXingQBankAddition,
  QBankRelationItem,
  QBankSearchResp,
  QBankUploadTokens,
} from "./types"

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
const REFERER = "https://mooc2-ans.chaoxing.com/"
const MOOC2_BASE = "https://mooc2-ans.chaoxing.com"
const MOOC1_BASE = "https://mooc1.chaoxing.com"
const LOGIN_URL = "https://passport2.chaoxing.com/fanyalogin"
const LOGIN_KEY = "u2oh6Vu^HWe4_AES"
const ALL_QTYPES = "0,1,2,3,4,5,6,7,8,9,10,11,13,14,15,16,17,18,19,20,21,22,23,24,25,26"

const ALLOWED_EXTS = new Set([
  "txt",
  "mp3",
  "wav",
  "flac",
  "jpg",
  "jpeg",
  "png",
  "gif",
  "mp4",
  "pdf",
  "zip",
  "7z",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
])

export function safeQBankUploadName(originalName: string): string {
  const dot = originalName.lastIndexOf(".")
  const ext = dot >= 0 ? originalName.slice(dot + 1).toLowerCase() : ""
  return ALLOWED_EXTS.has(ext) ? `sync_stage.${ext}` : "sync_stage.txt"
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

export function formatQuestionContent(
  fileName: string,
  objectId: string,
  size: number,
): string {
  const escName = escapeHtml(fileName)
  const href = `/ueditorupload/read?objectId=${encodeURIComponent(objectId)}&fncs_size=${size}&fncs_name=${encodeURIComponent(fileName)}`
  return `<p>${escName}</p><p><a class="ans-attach-online" href="${escapeHtml(href)}">${escName}</a></p>`
}

export function parseQuestionFileMeta(content: string): {
  name: string
  objectId: string
  size: number
} | null {
  let objectId = ""
  let name = ""
  let size = 0

  const hrefMatch = content.match(/href=["']([^"']*ueditorupload\/read[^"']*)["']/i)
  if (hrefMatch?.[1]) {
    try {
      const u = new URL(unescapeHtml(hrefMatch[1]), MOOC2_BASE)
      objectId = (u.searchParams.get("objectId") || "").trim()
      const sz = Number(u.searchParams.get("fncs_size") || "0")
      if (Number.isFinite(sz) && sz > 0) size = sz
      name = (u.searchParams.get("fncs_name") || "").trim()
    } catch {
      // ignore malformed href
    }
  }
  if (!objectId) {
    const m = content.match(/objectid=["']([0-9a-fA-F]{16,})["']/i)
    if (m?.[1]) objectId = m[1]
  }
  if (!name) {
    const m = content.match(/filename=["']([^"']+)["']/i)
    if (m?.[1]) name = unescapeHtml(m[1])
  }
  if (!objectId || !name) return null
  return { name, objectId, size }
}

export class ClientChaoXingQBank {
  private addition: DriverChaoXingQBankAddition
  private cookie = ""
  private cpi = ""
  private persistCookie?: (cookie: string) => void | Promise<void>

  constructor(
    addition: DriverChaoXingQBankAddition,
    persistCookie?: (cookie: string) => void | Promise<void>,
  ) {
    this.addition = addition
    this.cookie = (addition.cookie || "").trim()
    this.persistCookie = persistCookie
  }

  async init(): Promise<void> {
    if (!this.addition.course_id?.trim()) {
      throw new Error("[ChaoXingQBank] course_id is required")
    }
    if (!this.cookie) {
      await this.login()
    }
    await this.ensureCpi()
  }

  async login(): Promise<void> {
    if (!this.addition.user_name || !this.addition.password) {
      throw new Error("[ChaoXingQBank] user_name and password are required")
    }
    const encUser = await aesCbcEncryptBase64(this.addition.user_name, LOGIN_KEY)
    const encPass = await aesCbcEncryptBase64(this.addition.password, LOGIN_KEY)

    const body = new URLSearchParams({
      fid: "-1",
      uname: encUser,
      password: encPass,
      refer: "https://i.chaoxing.com",
      t: "true",
      forbidotherlogin: "0",
      validate: "",
      doubleFactorLogin: "0",
      independentId: "0",
      independentNameId: "0",
    })

    const res = await fetch(LOGIN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "User-Agent": UA,
        Referer: "https://passport2.chaoxing.com/",
      },
      body: body.toString(),
    })
    const data = (await res.json()) as {
      status?: boolean
      msg2?: string
      mes?: string
    }
    if (!data.status) {
      throw new Error(
        `[ChaoXingQBank] login failed: ${data.msg2 || data.mes || "unknown error"}`,
      )
    }

    const cookies = extractSetCookies(res.headers)
    if (cookies.length === 0) {
      throw new Error("[ChaoXingQBank] login succeeded but no Set-Cookie returned")
    }
    this.cookie = cookies.join("; ")
    await this.persistCookie?.(this.cookie)
  }

  private async requestText(
    url: string,
    init: RequestInit = {},
    allowRetry = true,
  ): Promise<string> {
    if (!this.cookie && this.addition.user_name && this.addition.password) {
      await this.login()
    }
    const res = await fetch(url, {
      ...init,
      redirect: "manual",
      headers: {
        Cookie: this.cookie,
        Referer: REFERER,
        "User-Agent": UA,
        ...(init.headers || {}),
      },
    })
    if (
      (res.status === 301 || res.status === 302 || res.status === 401 || res.status === 403) &&
      allowRetry &&
      this.addition.user_name &&
      this.addition.password
    ) {
      await this.login()
      return this.requestText(url, init, false)
    }
    if (!res.ok) {
      throw new Error(`[ChaoXingQBank] HTTP ${res.status} for ${url}`)
    }
    const text = await res.text()
    if (
      (text.includes("<title>用户登录</title>") ||
        text.includes("passport2.chaoxing.com/login")) &&
      allowRetry &&
      this.addition.user_name &&
      this.addition.password
    ) {
      await this.login()
      return this.requestText(url, init, false)
    }
    return text
  }

  async ensureCpi(): Promise<string> {
    if (this.cpi) return this.cpi
    const html = await this.requestText(
      `${MOOC2_BASE}/mooc2-ans/qbank/questionlist?courseid=${encodeURIComponent(this.addition.course_id)}`,
    )
    const m =
      html.match(/id=["']cpi["'][^>]*value=["'](\d+)["']/i) ||
      html.match(/cpi\s*[:=]\s*["']?(\d+)/i)
    if (!m?.[1]) {
      throw new Error("[ChaoXingQBank] failed to extract cpi from questionlist")
    }
    this.cpi = m[1]
    return this.cpi
  }

  async searchAll(dirId: string): Promise<QBankRelationItem[]> {
    const cpi = await this.ensureCpi()
    const out: QBankRelationItem[] = []
    for (let page = 1; page <= 100; page++) {
      const form = new URLSearchParams({
        courseid: this.addition.course_id,
        cpi,
        courseIds: this.addition.course_id,
        dirId: dirId || "0",
        dirCourseId: this.addition.course_id,
        pageNum: String(page),
        pageSize: "100",
        qbanksystem: "1",
        needHtml: "false",
        qTypes: ALL_QTYPES,
        eTypes: "",
        topicIdStatus: "-1",
      })
      const raw = await this.requestText(`${MOOC2_BASE}/mooc2-ans/qbank/search`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body: form.toString(),
      })
      const data = JSON.parse(raw) as QBankSearchResp
      const list = data.questionBankRelationList || []
      out.push(...list)
      if (list.length < 100) break
    }
    return out
  }

  async insertDir(pid: string, dirName: string): Promise<string> {
    const cpi = await this.ensureCpi()
    const form = new URLSearchParams({
      dirName,
      courseid: this.addition.course_id,
      pid: pid || "0",
      cpi,
    })
    const raw = await this.requestText(`${MOOC2_BASE}/mooc2-ans/qbank/insertdir`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: form.toString(),
    })
    const res = JSON.parse(raw) as { status?: boolean; id?: number; msg?: string }
    if (!res.status || !res.id) {
      throw new Error(`[ChaoXingQBank] insertdir failed: ${res.msg || "unknown"}`)
    }
    return String(res.id)
  }

  async renameDir(id: string, pid: string, newName: string): Promise<void> {
    const cpi = await this.ensureCpi()
    const form = new URLSearchParams({
      dirName: newName,
      courseid: this.addition.course_id,
      pid: pid || "0",
      cpi,
      id,
    })
    const raw = await this.requestText(`${MOOC2_BASE}/mooc2-ans/qbank/update-dirname`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: form.toString(),
    })
    const res = JSON.parse(raw) as { status?: boolean; msg?: string }
    if (!res.status) {
      throw new Error(`[ChaoXingQBank] update-dirname failed: ${res.msg || "unknown"}`)
    }
  }

  async moveItem(operateId: string, newPid: string, isDir: boolean): Promise<void> {
    const cpi = await this.ensureCpi()
    const form = new URLSearchParams({
      courseid: this.addition.course_id,
      cpi,
      operateId,
      operateCourseId: this.addition.course_id,
      type: isDir ? "0" : "1",
      newPid: newPid || "0",
    })
    const raw = await this.requestText(`${MOOC2_BASE}/mooc2-ans/qbank/update-pid`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: form.toString(),
    })
    const res = JSON.parse(raw) as { status?: boolean | string; msg?: string }
    if (res.status !== true && res.status !== "true") {
      throw new Error(`[ChaoXingQBank] update-pid failed: ${res.msg || "unknown"}`)
    }
  }

  async deleteItem(id: string, isDir: boolean): Promise<void> {
    const cpi = await this.ensureCpi()
    const form = new URLSearchParams({
      courseid: this.addition.course_id,
      cpi,
      questionIds: isDir ? "" : id,
      dirIds: isDir ? id : "",
      status: "2",
    })
    const raw = await this.requestText(`${MOOC2_BASE}/mooc2-ans/qbank/batch-updatestatus`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: form.toString(),
    })
    const res = JSON.parse(raw) as { status?: boolean | string; msg?: string }
    if (res.status !== true && res.status !== "true") {
      throw new Error(`[ChaoXingQBank] batch-updatestatus failed: ${res.msg || "unknown"}`)
    }
  }

  async getUploadTokens(dirId: string): Promise<QBankUploadTokens> {
    const cpi = await this.ensureCpi()
    const html = await this.requestText(
      `${MOOC2_BASE}/mooc2-ans/qbank/create-question?courseid=${encodeURIComponent(this.addition.course_id)}&cpi=${encodeURIComponent(cpi)}&dirId=${encodeURIComponent(dirId || "0")}&qbanksystem=1&originType=4`,
    )
    const enc2 =
      html.match(/uploadEnc["']?[^>]*value=["']([0-9a-fA-F]+)["']/i)?.[1] ||
      html.match(/uploadEnc["']?\]\s*=\s*['"]([0-9a-fA-F]+)['"]/i)?.[1] ||
      ""
    const t = html.match(/uploadTimeStamp["']?[^>]*value=["'](\d+)["']/i)?.[1] || ""
    const uid = html.match(/uploadUid["']?[^>]*value=["'](\d+)["']/i)?.[1] || ""
    if (!enc2 || !t || !uid) {
      throw new Error("[ChaoXingQBank] missing upload tokens on create-question page")
    }
    return { enc2, t, uid }
  }

  async uploadAttachment(
    dirId: string,
    fileName: string,
    content: Uint8Array,
  ): Promise<string> {
    const tok = await this.getUploadTokens(dirId)
    const stageName = safeQBankUploadName(fileName)
    const fd = new FormData()
    fd.append("upfile", new Blob([new Uint8Array(content)]), stageName)

    const upUrl = `${MOOC1_BASE}/upload-ans/ueditorupload/attachment?enc2=${encodeURIComponent(tok.enc2)}&t=${encodeURIComponent(tok.t)}&uid=${encodeURIComponent(tok.uid)}`
    const res = await fetch(upUrl, {
      method: "POST",
      headers: {
        Cookie: this.cookie,
        Referer: REFERER,
        "User-Agent": UA,
      },
      body: fd,
    })
    if (!res.ok) {
      throw new Error(`[ChaoXingQBank] upload HTTP ${res.status}`)
    }
    const data = (await res.json()) as {
      state?: string
      objectid?: string
      msg?: string
    }
    if (data.state !== "SUCCESS" || !data.objectid) {
      throw new Error(
        `[ChaoXingQBank] upload rejected: state=${data.state} msg=${data.msg || ""}`,
      )
    }
    return data.objectid
  }

  async saveQuestionFile(
    dirId: string,
    questionBankId: string,
    fileName: string,
    objectId: string,
    size: number,
  ): Promise<string> {
    const cpi = await this.ensureCpi()
    const form = new URLSearchParams({
      courseid: this.addition.course_id,
      cpi,
      dirId: dirId || "0",
      questionBankId,
      type: "4",
      originType: "4",
      qType: "0",
      courseQuestionTypeId: "0",
      content: formatQuestionContent(fileName, objectId, size),
      answer: "<p>ok</p>",
    })
    const saveUrl = `${MOOC2_BASE}/mooc2-ans/qbank/add_question?questionBankId=${encodeURIComponent(questionBankId)}&courseid=${encodeURIComponent(this.addition.course_id)}&microTopicId=0&saveAsNew=false&promptId=-1&useAi=0&autoScore=0&aiOptimized=0`
    const raw = await this.requestText(saveUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: form.toString(),
    })
    const res = JSON.parse(raw) as { status?: boolean; qid?: string; msg?: string }
    if (!res.status || !res.qid) {
      throw new Error(`[ChaoXingQBank] add_question failed: ${res.msg || "unknown"}`)
    }
    return res.qid
  }

  async resolveDownloadUrl(objectId: string): Promise<string> {
    const readUrl = `${MOOC1_BASE}/ueditorupload/read?objectId=${encodeURIComponent(objectId)}`
    const res = await fetch(readUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        Referer: REFERER,
        "User-Agent": UA,
      },
    })
    const loc = res.headers.get("location")
    if (!loc) {
      throw new Error(
        `[ChaoXingQBank] read?objectId=${objectId} returned HTTP ${res.status} without Location`,
      )
    }
    return loc
  }

  downloadHeaders(): Record<string, string> {
    return { Referer: REFERER, "User-Agent": UA }
  }
}
