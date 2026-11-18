import assert from "node:assert/strict"
import { test } from "node:test"
import { DriverChaoXing } from "./driver"
import {
  ClientChaoXing,
  extractSetCookies,
  parseChaoXingTimestamp,
} from "./util"

function jsonResponse(body: unknown, status = 200, extraHeaders?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...(extraHeaders || {}),
    },
  })
}

async function withMockFetch(
  handler: (url: URL, init?: RequestInit) => Promise<Response> | Response,
  fn: () => Promise<void>,
) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input))
    return handler(url, init)
  }) as typeof fetch
  try {
    await fn()
  } finally {
    globalThis.fetch = originalFetch
  }
}

test("parseChaoXingTimestamp handles numeric, string ms, date strings, and invalid inputs", () => {
  assert.equal(
    parseChaoXingTimestamp(1780191356415),
    new Date(1780191356415).toISOString(),
  )
  assert.equal(
    parseChaoXingTimestamp("1780191356415"),
    new Date(1780191356415).toISOString(),
  )
  assert.equal(
    parseChaoXingTimestamp("2024-11-06 07:49"),
    "2024-11-06T07:49:00.000Z",
  )
  assert.equal(
    parseChaoXingTimestamp("2024-11-06 07:49:30"),
    "2024-11-06T07:49:30.000Z",
  )

  for (const invalid of [undefined, "", "not-a-date", NaN, -1, 0]) {
    const iso = parseChaoXingTimestamp(invalid as any)
    assert.ok(
      !Number.isNaN(Date.parse(iso)),
      `expected valid ISO for ${invalid}`,
    )
  }
})

test("extractSetCookies handles getSetCookie and combined fallback with Expires comma", () => {
  const withGetSetCookie = new Headers()
  withGetSetCookie.append("set-cookie", "UID=123; Path=/; HttpOnly")
  withGetSetCookie.append("set-cookie", "_d=456; Path=/")
  assert.deepEqual(extractSetCookies(withGetSetCookie), ["UID=123", "_d=456"])

  const fallbackHeaders = {
    get(name: string) {
      if (name.toLowerCase() === "set-cookie") {
        return "SID=s1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/, UID=u1; HttpOnly"
      }
      return null
    },
  } as unknown as Headers
  assert.deepEqual(extractSetCookies(fallbackHeaders), ["SID=s1", "UID=u1"])
})

test("ClientChaoXing.login extracts multi-cookies and rejects status=false", async () => {
  await withMockFetch(
    async (url) => {
      assert.equal(url.href, "https://passport2.chaoxing.com/fanyalogin")
      const headers = new Headers()
      headers.append("set-cookie", "UID=1001; Path=/")
      headers.append("set-cookie", "fid=2002; Path=/")
      return new Response(JSON.stringify({ status: true }), {
        status: 200,
        headers,
      })
    },
    async () => {
      const client = new ClientChaoXing({
        user_name: "13800138000",
        password: "secret",
        bbsid: "999",
      })
      const cookie = await client.login()
      assert.equal(cookie, "UID=1001; fid=2002")
    },
  )

  await withMockFetch(
    async () =>
      jsonResponse({ status: false, msg2: "用户名或密码错误" }, 200, {
        "set-cookie": "route=1; Path=/",
      }),
    async () => {
      const client = new ClientChaoXing({
        user_name: "13800138000",
        password: "wrong",
        bbsid: "999",
      })
      await assert.rejects(
        () => client.login(),
        /\[ChaoXing\] login failed: 用户名或密码错误/,
      )
    },
  )
})

test("DriverChaoXing supports root_folder_id, pathCache, list, get, mkdir, rename, move, remove, put, and auto relogin", async () => {
  const listCalls: string[] = []
  const calls: Array<{ url: string; method: string; headers: Headers }> = []
  let expiredCookieTriggered = false
  let loginCount = 0
  const persistedCookies: string[] = []

  const rootFolderFiles = [
    {
      id: 101,
      inserttime: 1700000000000,
      content: { folderName: "docs" },
    },
    {
      id: 102,
      inserttime: 1700000001000,
      content: { folderName: "target" },
    },
  ]
  const docsFiles = [
    {
      id: 201,
      content: {
        name: "mobile.pdf",
        objectId: "obj-mobile-201",
        size: "2048",
        uploadDate: "1780191356415",
        thumbnail: "https://img.chaoxing.com/thumb.jpg",
      },
    },
    {
      id: 202,
      content: {
        name: "notes.txt",
        fileId: "file-202",
        size: 128,
        uploadDate: "2024-11-06 07:49",
      },
    },
  ]

  await withMockFetch(
    async (url, init) => {
      const headers = new Headers(init?.headers)
      calls.push({
        url: url.toString(),
        method: init?.method || "GET",
        headers,
      })

      if (url.hostname === "passport2.chaoxing.com") {
        loginCount++
        const respHeaders = new Headers()
        respHeaders.append("set-cookie", `UID=fresh-${loginCount}; Path=/`)
        return new Response(JSON.stringify({ status: true }), {
          status: 200,
          headers: respHeaders,
        })
      }

      if (url.pathname === "/pc/resource/getResourceList") {
        const folderId = url.searchParams.get("folderId")
        const recType = url.searchParams.get("recType")
        listCalls.push(`${folderId}:${recType}`)

        // First call with stale cookie returns 302 redirect / expired result
        if (!expiredCookieTriggered && headers.get("cookie") === "UID=stale") {
          expiredCookieTriggered = true
          return new Response("", {
            status: 302,
            headers: { location: "https://passport2.chaoxing.com/login" },
          })
        }

        if (folderId === "888") {
          return jsonResponse({
            result: 1,
            list: recType === "1" ? rootFolderFiles : [],
          })
        }
        if (folderId === "101") {
          return jsonResponse({
            result: 1,
            list: recType === "1" ? [] : docsFiles,
          })
        }
        if (folderId === "102") {
          return jsonResponse({ result: 1, list: [] })
        }
        return jsonResponse({ result: 1, list: [] })
      }

      if (url.pathname === "/screen/note_note/files/status/obj-mobile-201") {
        return jsonResponse({
          status: true,
          download: "https://d.chaoxing.com/download/obj-mobile-201",
        })
      }

      if (url.pathname === "/pc/resource/addResourceFolder") {
        assert.equal(url.searchParams.get("pid"), "101")
        assert.equal(url.searchParams.get("name"), "newdir")
        return jsonResponse({ result: 1 })
      }

      if (url.pathname === "/pc/resource/updateResourceFolderName") {
        assert.equal(url.searchParams.get("folderId"), "101")
        assert.equal(url.searchParams.get("name"), "docs-renamed")
        return jsonResponse({ result: 1 })
      }

      if (url.pathname === "/pc/resource/moveResource") {
        assert.equal(url.searchParams.get("recIds"), "202")
        assert.equal(url.searchParams.get("targetId"), "102")
        return jsonResponse({ status: true })
      }

      if (url.pathname === "/pc/resource/deleteResourceFile") {
        assert.equal(url.searchParams.get("recIds"), "202")
        return jsonResponse({ result: 1 })
      }

      if (url.pathname === "/pc/resource/deleteResourceFolder") {
        assert.equal(url.searchParams.get("folderIds"), "102")
        return jsonResponse({ result: 1 })
      }

      if (url.pathname === "/pc/files/getUploadConfig") {
        assert.equal(headers.get("cookie"), "UID=fresh-1")
        assert.equal(headers.get("referer"), "https://chaoxing.com/")
        return jsonResponse({
          result: 1,
          msg: { puid: 54321, token: "upload-tok-1" },
        })
      }

      if (url.href === "https://pan-yz.chaoxing.com/upload") {
        assert.equal(headers.get("referer"), "https://chaoxing.com/")
        return jsonResponse({
          result: true,
          msg: "success",
          objectId: "obj-uploaded-1",
          data: { objectId: "obj-uploaded-1", name: "hello.txt", size: 5 },
        })
      }

      if (url.pathname === "/pc/resource/addResource") {
        assert.equal(url.searchParams.get("pid"), "101")
        assert.equal(url.searchParams.get("bbsid"), "bbs-1")
        return jsonResponse({ result: 1 })
      }

      throw new Error(`Unexpected fetch: ${url.href}`)
    },
    async () => {
      const driver = new DriverChaoXing(
        {
          user_name: "13800138000",
          password: "secret",
          bbsid: "bbs-1",
          root_folder_id: "888",
          cookie: "UID=stale",
        },
        (cookie) => {
          persistedCookies.push(cookie)
        },
      )

      await driver.init()
      assert.equal(loginCount, 0)

      // 1. list("/") uses root_folder_id "888" and recovers from stale cookie via relogin
      const rootItems = await driver.list("/cx", "/")
      assert.equal(loginCount, 1)
      assert.deepEqual(persistedCookies, ["UID=fresh-1"])
      assert.equal(rootItems.length, 2)
      assert.equal(rootItems[0].name, "docs")
      assert.equal(rootItems[0].is_dir, true)

      // 2. list("/docs") handles mobile objectId fallback + numeric string timestamp + thumbnail
      const docItems = await driver.list("/cx/docs", "/docs")
      assert.equal(docItems.length, 2)
      assert.equal(docItems[0].name, "mobile.pdf")
      assert.equal(docItems[0].size, 2048)
      assert.equal(docItems[0].sign, "201$obj-mobile-201")
      assert.equal(docItems[0].modified, new Date(1780191356415).toISOString())
      assert.equal(docItems[0].thumb, "https://img.chaoxing.com/thumb.jpg")
      assert.equal(docItems[1].modified, "2024-11-06T07:49:00.000Z")

      // 3. pathCache hit: second list("/docs") should NOT re-query root folder "888"
      const listCallsBefore = listCalls.length
      await driver.list("/cx/docs", "/docs")
      const newCalls = listCalls.slice(listCallsBefore)
      assert.ok(
        !newCalls.some((c) => c.startsWith("888:")),
        `Expected pathCache hit to skip root folder 888, got ${newCalls}`,
      )

      // 4. get() resolves raw_url + raw_url_headers with refreshed cookie
      const fileItem = await driver.get(
        "/cx/docs/mobile.pdf",
        "/docs/mobile.pdf",
      )
      assert.equal(
        fileItem.raw_url,
        "https://d.chaoxing.com/download/obj-mobile-201",
      )
      assert.equal(fileItem.raw_url_headers?.Cookie, "UID=fresh-1")
      assert.equal(fileItem.raw_url_headers?.Referer, "https://chaoxing.com/")

      // 5. mkdir / rename / move / remove / put
      await driver.mkdir("/cx/docs/newdir", "/docs/newdir")
      await driver.rename("/cx/docs", "/docs", "docs-renamed")
      await assert.rejects(
        () => driver.rename("/cx/docs/notes.txt", "/docs/notes.txt", "n2.txt"),
        /不支持修改文件名/,
      )

      // move passes virtual dstDir ("/cx/target") and physical dstPhysical ("/target/notes.txt")
      await driver.move(
        "/cx/docs",
        "/cx/target",
        ["notes.txt"],
        "/docs/notes.txt",
        "/target/notes.txt",
      )

      await driver.remove("/cx/docs/notes.txt", "/docs/notes.txt", [
        "notes.txt",
      ])
      await driver.remove("/cx/target", "/target", ["target"])

      await driver.put(
        "/cx/docs/hello.txt",
        "/docs/hello.txt",
        new TextEncoder().encode("hello"),
      )
    },
  )
})
