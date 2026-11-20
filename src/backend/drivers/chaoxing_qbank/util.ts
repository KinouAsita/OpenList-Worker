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
const REFERER = "https://pan-yz.chaoxing.com/"
const MOOC2_BASE = "https://mooc2-ans.chaoxing.com"
const MOOC1_BASE = "https://mooc1.chaoxing.com"
const NOTEYD_BASE = "https://noteyd.chaoxing.com"
const PANYZ_BASE = "https://pan-yz.chaoxing.com"
const LOGIN_URL = "https://passport2.chaoxing.com/fanyalogin"
const LOGIN_KEY = "u2oh6Vu^HWe4_AES"
const ALL_QTYPES = "0,1,2,3,4,5,6,7,8,9,10,11,13,14,15,16,17,18,19,20,21,22,23,24,25,26"

const KNOWN_INTL_PREFIXES = [
  "852",
  "853",
  "886",
  "86",
  "44",
  "81",
  "82",
  "65",
  "60",
  "61",
  "64",
  "49",
  "33",
  "39",
  "34",
  "7",
  "1",
]

export function normalizeCountryCode(raw?: string): string {
  const s = (raw || "").trim().replace(/^\+/, "").replace(/^00/, "")
  const digits = s.replace(/\D/g, "")
  return digits || "86"
}

export function normalizePhoneAndCountryCode(
  rawUser?: string,
  rawCC?: string,
): { phone: string; countryCode: string } {
  const u = (rawUser || "").trim()
  const cc = normalizeCountryCode(rawCC)
  if (u.startsWith("+")) {
    const rest = u.slice(1)
    const sep = rest.search(/[\s-]/)
    if (sep > 0) {
      const prefix = normalizeCountryCode(rest.slice(0, sep))
      const num = rest.slice(sep + 1).replace(/\D/g, "")
      if (prefix && num) return { phone: num, countryCode: prefix }
    }
    const digits = rest.replace(/\D/g, "")
    for (const p of KNOWN_INTL_PREFIXES) {
      if (digits.startsWith(p) && digits.length > p.length + 4) {
        return { phone: digits.slice(p.length), countryCode: p }
      }
    }
    return { phone: digits, countryCode: cc }
  }
  return { phone: u, countryCode: cc }
}

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

export interface QBankFilePart {
  objectId: string
  size: number
}

export function encodeQBankParts(parts?: QBankFilePart[]): string {
  if (!parts || parts.length <= 1) return ""
  return parts.map((p) => `${p.objectId}:${p.size}`).join(",")
}

export function parseQBankParts(
  raw: string,
  fallbackObjectId: string,
  fallbackSize: number,
): QBankFilePart[] {
  const s = (raw || "").trim()
  if (s) {
    const out: QBankFilePart[] = []
    for (const tok of s.split(",")) {
      const idx = tok.indexOf(":")
      if (idx <= 0) continue
      const oid = tok.slice(0, idx).trim()
      const sz = Number(tok.slice(idx + 1).trim())
      if (oid && Number.isFinite(sz) && sz > 0) {
        out.push({ objectId: oid, size: sz })
      }
    }
    if (out.length > 0) return out
  }
  return fallbackObjectId ? [{ objectId: fallbackObjectId, size: fallbackSize }] : []
}

export function formatQuestionContent(
  fileName: string,
  objectId: string,
  size: number,
  md5Hex = "",
  parts?: QBankFilePart[],
): string {
  const escName = escapeHtml(fileName)
  let href = `/ueditorupload/read?objectId=${encodeURIComponent(objectId)}&fncs_size=${size}&fncs_name=${encodeURIComponent(fileName)}`
  if (md5Hex.trim()) {
    href += `&fncs_md5=${encodeURIComponent(md5Hex.trim())}`
  }
  const encParts = encodeQBankParts(parts)
  if (encParts) {
    href += `&fncs_parts=${encodeURIComponent(encParts)}`
  }
  let out = `<p>${escName}</p><p><a class="ans-attach-online" href="${escapeHtml(href)}">${escName}</a></p>`
  if (parts && parts.length > 1) {
    for (let i = 1; i < parts.length; i++) {
      const partHref = `/ueditorupload/read?objectId=${encodeURIComponent(parts[i].objectId)}`
      const partLabel = escapeHtml(`${fileName}.part${i}`)
      out += `<p><a class="ans-attach-online" href="${escapeHtml(partHref)}">${partLabel}</a></p>`
    }
  }
  return out
}

export function parseQuestionFileMeta(content: string): {
  name: string
  objectId: string
  size: number
  md5: string
  parts: QBankFilePart[]
} | null {
  let objectId = ""
  let name = ""
  let size = 0
  let md5 = ""
  let rawParts = ""

  const hrefMatch = content.match(/href=["']([^"']*ueditorupload\/read[^"']*)["']/i)
  if (hrefMatch?.[1]) {
    try {
      const u = new URL(unescapeHtml(hrefMatch[1]), MOOC2_BASE)
      objectId = (u.searchParams.get("objectId") || "").trim()
      const sz = Number(u.searchParams.get("fncs_size") || "0")
      if (Number.isFinite(sz) && sz > 0) size = sz
      name = (u.searchParams.get("fncs_name") || "").trim()
      md5 = (u.searchParams.get("fncs_md5") || "").trim()
      rawParts = (u.searchParams.get("fncs_parts") || "").trim()
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
  const parts = parseQBankParts(rawParts, objectId, size)
  if (!objectId && parts.length > 0) objectId = parts[0].objectId
  if (size === 0 && parts.length > 0) {
    size = parts.reduce((acc, p) => acc + p.size, 0)
  }
  if (!objectId || !name) return null
  return { name, objectId, size, md5, parts }
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
    const { phone, countryCode } = normalizePhoneAndCountryCode(
      this.addition.user_name,
      this.addition.country_code,
    )
    if (!phone || !this.addition.password) {
      throw new Error("[ChaoXingQBank] user_name and password are required")
    }
    const encUser = await aesCbcEncryptBase64(phone, LOGIN_KEY)
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
      countrycode: countryCode,
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
      const data = JSON.parse(raw) as QBankSearchResp & {
        status?: boolean | string
        msg?: string
      }
      if (
        data.status !== undefined &&
        data.status !== true &&
        data.status !== "true"
      ) {
        throw new Error(
          `[ChaoXingQBank] search dir=${dirId} failed: ${data.msg || "unknown"}`,
        )
      }
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
    md5Hex = "",
    parts?: QBankFilePart[],
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
      content: formatQuestionContent(fileName, objectId, size, md5Hex, parts),
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
    const statusUrl = `${NOTEYD_BASE}/screen/note_note/files/status/${encodeURIComponent(objectId)}`
    const readUrl = `${MOOC1_BASE}/ueditorupload/read?objectId=${encodeURIComponent(objectId)}`
    const panExtUrl = `${PANYZ_BASE}/external/m/file/${encodeURIComponent(objectId)}`

    // 1. Primary: noteyd /screen/note_note/files/status/<objectId> works for ALL file types (.wav, .mp3, .jpg, .zip, .txt, etc.)
    try {
      const stRes = await fetch(statusUrl, {
        method: "POST",
        headers: {
          Cookie: this.cookie,
          Referer: REFERER,
          "User-Agent": UA,
        },
      })
      if (stRes.ok) {
        const stJson = (await stRes.json()) as { download?: string }
        if (stJson?.download?.trim()) {
          return stJson.download.trim()
        }
      }
    } catch {
      // fall through to fallbacks
    }

    // 2. Fallback 1: mooc1 /ueditorupload/read?objectId=<objectId> (302 Location for non-media files)
    try {
      const res = await fetch(readUrl, {
        method: "GET",
        redirect: "manual",
        headers: {
          Referer: REFERER,
          "User-Agent": UA,
        },
      })
      const loc = res.headers.get("location")
      if (loc?.trim()) {
        return loc.trim()
      }
    } catch {
      // fall through
    }

    // 3. Fallback 2: pan-yz /external/m/file/<objectId>
    try {
      const extRes = await fetch(panExtUrl, {
        method: "GET",
        headers: {
          Referer: REFERER,
          "User-Agent": UA,
        },
      })
      if (extRes.ok) {
        const html = await extRes.text()
        const m = html.match(/['"]download['"]\s*:\s*['"](https?:\/\/[^'"]+)['"]/)
        if (m?.[1] && m[1].includes("at_=")) {
          return m[1].trim()
        }
      }
    } catch {
      // fall through
    }

    throw new Error(
      `[ChaoXingQBank] failed to resolve download url for objectId=${objectId}`,
    )
  }

  downloadHeaders(): Record<string, string> {
    return { Referer: REFERER, "User-Agent": UA }
  }
}
