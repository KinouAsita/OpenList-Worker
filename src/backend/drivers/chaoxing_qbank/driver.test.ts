import assert from "node:assert/strict"
import { test } from "node:test"
import { DriverChaoXingQBank } from "./driver"
import { normalizePhoneAndCountryCode } from "./util"

test("DriverChaoXingQBank supports login, cpi discovery, mkdir, upload (.vtt staged), list, 302 get, rename, and remove", async () => {
  const dirs = new Map<number, { id: number; pid: number; name: string }>([
    [101, { id: 101, pid: 0, name: "sub_folder_more_than_16_chars" }],
  ])
  const questions = new Map<string, { id: string; dirId: number; content: string }>()
  const blobs = new Map<string, Uint8Array>()
  let dirSeq = 200
  let qSeq = 0

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url
    if (url.includes("/fanyalogin")) {
      const headers = new Headers({
        "set-cookie": "UID=qb-123; Path=/",
        "content-type": "application/json",
      })
      return new Response(JSON.stringify({ status: true }), { status: 200, headers })
    }
    if (url.includes("/mooc2-ans/qbank/questionlist")) {
      return new Response('<input type="hidden" id="cpi" value="3726978"/>', {
        status: 200,
      })
    }
    if (url.includes("/mooc2-ans/qbank/create-question")) {
      return new Response(
        '<input id="uploadEnc" value="abc123"/><input id="uploadTimeStamp" value="1700000"/><input id="uploadUid" value="213718138"/>',
        { status: 200 },
      )
    }
    if (url.includes("/upload-ans/ueditorupload/attachment")) {
      const fd = init?.body as FormData
      const file = fd.get("upfile") as File
      assert.equal(file.name, "sync_stage.txt")
      const buf = new Uint8Array(await file.arrayBuffer())
      const objId = "obj-qb-1"
      blobs.set(objId, buf)
      return new Response(
        JSON.stringify({ state: "SUCCESS", objectid: objId, size: buf.byteLength }),
        { status: 200 },
      )
    }
    if (url.includes("/mooc2-ans/qbank/add_question")) {
      const body = new URLSearchParams(String(init?.body || ""))
      const dirId = Number(body.get("dirId") || "0")
      let qid = body.get("questionBankId") || ""
      if (!qid) {
        qSeq++
        qid = `qid-${qSeq}`
      }
      questions.set(qid, { id: qid, dirId, content: body.get("content") || "" })
      return new Response(JSON.stringify({ status: true, qid }), { status: 200 })
    }
    if (url.includes("/mooc2-ans/qbank/insertdir")) {
      const body = new URLSearchParams(String(init?.body || ""))
      dirSeq++
      const id = dirSeq
      dirs.set(id, {
        id,
        pid: Number(body.get("pid") || "0"),
        name: body.get("dirName") || "",
      })
      return new Response(JSON.stringify({ status: true, id }), { status: 200 })
    }
    if (url.includes("/mooc2-ans/qbank/search")) {
      const body = new URLSearchParams(String(init?.body || ""))
      const dirId = Number(body.get("dirId") || "0")
      const list: any[] = []
      for (const d of dirs.values()) {
        if (d.pid === dirId) {
          list.push({ id: d.id, pid: d.pid, dirName: d.name })
        }
      }
      for (const q of questions.values()) {
        if (q.dirId === dirId) {
          list.push({
            id: 0,
            pid: dirId,
            questionBank: { id: q.id, content: q.content, createTime: 1700000000000 },
          })
        }
      }
      return new Response(
        JSON.stringify({ total: list.length, questionBankRelationList: list }),
        { status: 200 },
      )
    }
    if (url.includes("/screen/note_note/files/status/")) {
      return new Response(
        JSON.stringify({
          status: true,
          download: "https://d0.cldisk.com/download/obj-qb-1?at_=123",
        }),
        { status: 200 },
      )
    }
    if (url.includes("/ueditorupload/read")) {
      return new Response("<html><title>浏览</title></html>", { status: 200 })
    }
    if (url.includes("/mooc2-ans/qbank/batch-updatestatus")) {
      const body = new URLSearchParams(String(init?.body || ""))
      for (const qid of (body.get("questionIds") || "").split(",").filter(Boolean)) {
        questions.delete(qid)
      }
      return new Response(JSON.stringify({ status: "true" }), { status: 200 })
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch

  try {
    const drv = new DriverChaoXingQBank({
      user_name: "u",
      password: "p",
      course_id: "269437447",
    })
    await drv.init()

    const payload = new TextEncoder().encode("hello qbank 302")
    await drv.put(
      "/sub_folder_more_than_16_chars/sub.vtt",
      "/sub_folder_more_than_16_chars/sub.vtt",
      payload,
    )

    const items = await drv.list(
      "/sub_folder_more_than_16_chars",
      "/sub_folder_more_than_16_chars",
    )
    assert.equal(items.length, 1)
    assert.equal(items[0].name, "sub.vtt")
    assert.equal(items[0].size, payload.byteLength)

    const got = await drv.get(
      "/sub_folder_more_than_16_chars/sub.vtt",
      "/sub_folder_more_than_16_chars/sub.vtt",
    )
    assert.equal(got.raw_url, "https://d0.cldisk.com/download/obj-qb-1?at_=123")

    await drv.rename(
      "/sub_folder_more_than_16_chars/sub.vtt",
      "/sub_folder_more_than_16_chars/sub.vtt",
      "renamed.vtt",
    )
    const itemsAfterRename = await drv.list(
      "/sub_folder_more_than_16_chars",
      "/sub_folder_more_than_16_chars",
    )
    assert.equal(itemsAfterRename[0].name, "renamed.vtt")

    await drv.remove(
      "/sub_folder_more_than_16_chars/renamed.vtt",
      "/sub_folder_more_than_16_chars/renamed.vtt",
      ["renamed.vtt"],
    )
    const itemsAfterRemove = await drv.list(
      "/sub_folder_more_than_16_chars",
      "/sub_folder_more_than_16_chars",
    )
    assert.equal(itemsAfterRemove.length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("normalizePhoneAndCountryCode supports +44/+1/+852/+86", () => {
  assert.deepEqual(normalizePhoneAndCountryCode("13800138000", ""), {
    phone: "13800138000",
    countryCode: "86",
  })
  assert.deepEqual(normalizePhoneAndCountryCode("7700900123", "+44"), {
    phone: "7700900123",
    countryCode: "44",
  })
  assert.deepEqual(normalizePhoneAndCountryCode("+44 7700900123", "86"), {
    phone: "7700900123",
    countryCode: "44",
  })
  assert.deepEqual(normalizePhoneAndCountryCode("+1-5551234567", ""), {
    phone: "5551234567",
    countryCode: "1",
  })
  assert.deepEqual(normalizePhoneAndCountryCode("+852 91234567", ""), {
    phone: "91234567",
    countryCode: "852",
  })
})

test("DriverChaoXingQBank supports >1GiB chunked put, raw_parts get, and rename preserving fncs_parts", async () => {
  let objSeq = 0
  let qContent = ""
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    if (url.includes("/fanyalogin")) {
      return new Response(JSON.stringify({ status: true }), {
        status: 200,
        headers: { "set-cookie": "_d=token_ok; Path=/" },
      })
    }
    if (url.includes("/mooc2-ans/qbank/questionlist")) {
      return new Response(`<input id="cpi" value="12345" />`, { status: 200 })
    }
    if (url.includes("/mooc2-ans/qbank/create-question")) {
      return new Response(
        `<input id="uploadEnc" value="aabbcc" /><input id="uploadTimeStamp" value="1700000000" /><input id="uploadUid" value="1" />`,
        { status: 200 },
      )
    }
    if (url.includes("/upload-ans/ueditorupload/attachment")) {
      objSeq++
      return new Response(
        JSON.stringify({ state: "SUCCESS", objectid: `chunkobj${objSeq}` }),
        { status: 200 },
      )
    }
    if (url.includes("/mooc2-ans/qbank/add_question")) {
      const form = new URLSearchParams(String(init?.body || ""))
      qContent = form.get("content") || ""
      return new Response(JSON.stringify({ status: true, qid: "q-mp-1" }), {
        status: 200,
      })
    }
    if (url.includes("/mooc2-ans/qbank/search")) {
      const list = qContent
        ? [{ id: 0, pid: 0, questionBank: { id: "q-mp-1", content: qContent } }]
        : []
      return new Response(
        JSON.stringify({ total: list.length, status: true, questionBankRelationList: list }),
        { status: 200 },
      )
    }
    if (url.includes("/screen/note_note/files/status/")) {
      const oid = url.split("/").pop()
      return new Response(
        JSON.stringify({ download: `https://d0.cldisk.com/dl/${oid}` }),
        { status: 200 },
      )
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch

  try {
    const drv = new DriverChaoXingQBank({
      user_name: "u",
      password: "p",
      course_id: "269436499",
    })
    drv.chunkThreshold = 200
    drv.chunkSize = 100
    await drv.init()

    const payload = new Uint8Array(350)
    await drv.put("/movie.mkv", "/movie.mkv", payload)
    assert.equal(objSeq, 4)
    assert.ok(qContent.includes("fncs_parts="))
    assert.ok(qContent.includes("objectId=chunkobj4"))

    const got = await drv.get("/movie.mkv", "/movie.mkv")
    assert.equal(got.size, 350)
    assert.equal(got.raw_parts?.length, 4)
    assert.equal(await got.raw_parts?.[2].resolveUrl(), "https://d0.cldisk.com/dl/chunkobj3")

    await drv.rename("/movie.mkv", "/movie.mkv", "movie_renamed.mkv")
    assert.ok(qContent.includes("fncs_parts="))
    assert.ok(qContent.includes("objectId=chunkobj4"))
  } finally {
    globalThis.fetch = originalFetch
  }
})
