import assert from "node:assert/strict"
import { test } from "node:test"
import { Hono } from "hono"
import { adminRouter } from "./admin"
import { listItems } from "../internal/op/storage"
import { getDb, saveDb } from "../internal/model/db"
import { driverMustProxy } from "../internal/driver/proxy"

/**
 * Issue #107 回归：GitHub Releases / CNB Releases 必须出现在后台驱动列表中；
 * 覆盖 /driver/list、/driver/names、/driver/info 与创建存储后的端到端列目录。
 */

const authHeaders = { Authorization: "Bearer admin-token" }

async function setupEnv(): Promise<any> {
  const env: any = {}
  await saveDb(
    {
      settings: [{ key: "token", value: "admin-token" }],
      users: [],
      storages: [],
      shares: [],
      metas: [],
    },
    env,
  )
  return env
}

function makeApp(): Hono {
  const app = new Hono()
  app.route("/api/admin", adminRouter)
  return app
}

test("driver/list 包含 GitHub Releases 与 CNB Releases", async () => {
  const env = await setupEnv()
  const res = await makeApp().request(
    "/api/admin/driver/list",
    { method: "GET", headers: authHeaders },
    env,
  )
  assert.equal(res.status, 200)
  const body: any = await res.json()
  assert.equal(body.code, 200)

  const ghr = body.data["GitHub Releases"]
  assert.ok(ghr, "GitHub Releases 必须出现在驱动列表中")
  assert.equal(ghr.name, "GitHub Releases")
  assert.equal(ghr.default_mount_path, "/github_releases")
  assert.equal(ghr.config.no_upload, true)
  assert.equal(ghr.config.local_sort, false)
  const ghrFields = ghr.additional.map((f: any) => f.name)
  for (const field of [
    "root_folder_path",
    "repo_structure",
    "show_readme",
    "token",
    "show_source_code",
    "show_all_version",
    "per_page",
    "max_page",
    "gh_proxy",
  ]) {
    assert.ok(ghrFields.includes(field), `GitHub Releases 缺少字段 ${field}`)
  }
  const repoStructure = ghr.additional.find(
    (f: any) => f.name === "repo_structure",
  )
  assert.equal(repoStructure.required, true)
  assert.equal(repoStructure.default, "OpenListTeam/OpenList")

  const cnb = body.data["CNB Releases"]
  assert.ok(cnb, "CNB Releases 必须出现在驱动列表中")
  assert.equal(cnb.name, "CNB Releases")
  assert.equal(cnb.default_mount_path, "/cnb_releases")
  const cnbFields = cnb.additional.map((f: any) => f.name)
  for (const field of [
    "root_folder_id",
    "repo",
    "token",
    "use_tag_name",
    "default_branch",
  ]) {
    assert.ok(cnbFields.includes(field), `CNB Releases 缺少字段 ${field}`)
  }
})

test("driver/names 包含 GitHub Releases 与 CNB Releases", async () => {
  const env = await setupEnv()
  const res = await makeApp().request(
    "/api/admin/driver/names",
    { method: "GET", headers: authHeaders },
    env,
  )
  assert.equal(res.status, 200)
  const body: any = await res.json()
  assert.ok(body.data.includes("GitHub Releases"))
  assert.ok(body.data.includes("CNB Releases"))
})

test("driver/info 支持精确名与 Go 风格名（GithubReleases/大小写）", async () => {
  const env = await setupEnv()
  const app = makeApp()

  const exact = await app.request(
    `/api/admin/driver/info?driver=${encodeURIComponent("GitHub Releases")}`,
    { method: "GET", headers: authHeaders },
    env,
  )
  const exactBody: any = await exact.json()
  assert.equal(exactBody.data.name, "GitHub Releases")

  // Go 导入名（无空格）也要命中，编辑页依赖同一份配置
  const goStyle = await app.request(
    "/api/admin/driver/info?driver=GithubReleases",
    { method: "GET", headers: authHeaders },
    env,
  )
  const goStyleBody: any = await goStyle.json()
  assert.equal(goStyleBody.data.name, "GitHub Releases")

  const cnb = await app.request(
    "/api/admin/driver/info?driver=cnb_releases",
    { method: "GET", headers: authHeaders },
    env,
  )
  const cnbBody: any = await cnb.json()
  assert.equal(cnbBody.data.name, "CNB Releases")
})

test("通过 API 创建 GitHub Releases 存储并可列出资源（端到端）", async () => {
  const env = await setupEnv()
  const app = makeApp()

  const create = await app.request(
    "/api/admin/storage/create",
    {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        driver: "GitHub Releases",
        mount_path: "/ghr",
        addition: JSON.stringify({ repo_structure: "OpenListTeam/OpenList" }),
      }),
    },
    env,
  )
  assert.equal(create.status, 200)
  const created: any = await create.json()
  assert.equal(created.code, 200)
  // 必须按配置键原样落库，getDriver 才能命中 githubreleases 分支
  assert.equal(created.data.driver, "GitHub Releases")

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    if (url.includes("/repos/OpenListTeam/OpenList/releases/latest")) {
      return new Response(
        JSON.stringify({
          tag_name: "v1.0.0",
          created_at: "2026-01-01T00:00:00Z",
          published_at: "2026-01-02T00:00:00Z",
          html_url:
            "https://github.com/OpenListTeam/OpenList/releases/tag/v1.0.0",
          zipball_url:
            "https://github.com/OpenListTeam/OpenList/archive/refs/tags/v1.0.0.zip",
          tarball_url:
            "https://github.com/OpenListTeam/OpenList/archive/refs/tags/v1.0.0.tar.gz",
          assets: [
            {
              name: "openlist-linux-amd64.tar.gz",
              size: 1024,
              created_at: "2026-01-02T00:00:00Z",
              updated_at: "2026-01-02T00:00:00Z",
              browser_download_url:
                "https://github.com/OpenListTeam/OpenList/releases/download/v1.0.0/openlist-linux-amd64.tar.gz",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    if (url.includes("/repos/OpenListTeam/OpenList/contents")) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response("", { status: 404 })
  }) as typeof fetch

  try {
    const { content, provider } = await listItems("/ghr", { env })
    assert.equal(provider, "GitHub Releases")
    const asset = content.find((i) => i.name === "openlist-linux-amd64.tar.gz")
    assert.ok(asset, `未列出 release 资产: ${JSON.stringify(content)}`)
    assert.equal(asset!.is_dir, false)
    assert.equal(asset!.raw_url?.includes("releases/download/v1.0.0"), true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("存储列表中的驱动配置可被 driver/info 复用（前端编辑页）", async () => {
  const env = await setupEnv()
  const app = makeApp()
  const list = await app.request(
    "/api/admin/driver/list",
    { method: "GET", headers: authHeaders },
    env,
  )
  const listBody: any = await list.json()
  const keys = Object.keys(listBody.data)

  for (const key of keys) {
    // 与前端一致：按 key 请求 driver/info 必须精确命中
    const info = await app.request(
      `/api/admin/driver/info?driver=${encodeURIComponent(key)}`,
      { method: "GET", headers: authHeaders },
      env,
    )
    const infoBody: any = await info.json()
    assert.equal(
      infoBody.data.name,
      key,
      `driver/info 未返回 ${key} 自身的配置`,
    )
  }
})

test("driver/list、driver/names 与 driver/info 支持超星小组盘（ChaoXingGroupDrive）", async () => {
  const env = await setupEnv()
  const app = makeApp()

  const listRes = await app.request(
    "/api/admin/driver/list",
    { method: "GET", headers: authHeaders },
    env,
  )
  assert.equal(listRes.status, 200)
  const listBody: any = await listRes.json()
  const cx = listBody.data["ChaoXingGroupDrive"]
  assert.ok(cx, "ChaoXingGroupDrive 必须出现在驱动列表中")
  assert.equal(cx.name, "ChaoXingGroupDrive")
  assert.equal(cx.default_mount_path, "/chaoxing")
  assert.equal(cx.config.only_proxy, true)
  assert.equal(cx.config.default_root, "-1")
  assert.equal(cx.config.no_upload, false)
  assert.equal(driverMustProxy("ChaoXingGroupDrive"), true)

  const policyField = cx.common.find((f: any) => f.name === "webdav_policy")
  assert.ok(policyField)
  assert.equal(policyField.options, "use_proxy_url,native_proxy")
  assert.equal(policyField.default, "native_proxy")

  const cxFields = cx.additional.map((f: any) => f.name)
  for (const field of [
    "root_folder_id",
    "user_name",
    "password",
    "bbsid",
    "cookie",
  ]) {
    assert.ok(cxFields.includes(field), `ChaoXingGroupDrive 缺少字段 ${field}`)
  }

  const namesRes = await app.request(
    "/api/admin/driver/names",
    { method: "GET", headers: authHeaders },
    env,
  )
  const namesBody: any = await namesRes.json()
  assert.ok(namesBody.data.includes("ChaoXingGroupDrive"))

  for (const alias of [
    "ChaoXingGroupDrive",
    "chaoxing",
    "chaoxinggroupdrive",
    "超星小组盘",
  ]) {
    const infoRes = await app.request(
      `/api/admin/driver/info?driver=${encodeURIComponent(alias)}`,
      { method: "GET", headers: authHeaders },
      env,
    )
    const infoBody: any = await infoRes.json()
    assert.equal(
      infoBody.data.name,
      "ChaoXingGroupDrive",
      `alias=${alias} 应解析到 ChaoXingGroupDrive`,
    )
  }
})

test("通过 API 创建并更新超星小组盘存储：持久化 Cookie 并列出目录（端到端）", async () => {
  const env = await setupEnv()
  const app = makeApp()

  let loginSeq = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input))
    if (url.hostname === "passport2.chaoxing.com") {
      loginSeq++
      const headers = new Headers()
      headers.append("set-cookie", `UID=cx-cookie-${loginSeq}; Path=/`)
      headers.append("set-cookie", `fid=100; Path=/`)
      return new Response(JSON.stringify({ status: true }), {
        status: 200,
        headers,
      })
    }
    if (url.pathname === "/pc/resource/getResourceList") {
      const recType = url.searchParams.get("recType")
      const folderId = url.searchParams.get("folderId")
      assert.equal(folderId, "root-cx-99")
      return new Response(
        JSON.stringify({
          result: 1,
          list:
            recType === "1"
              ? [
                  {
                    id: 10,
                    inserttime: 1700000000000,
                    content: { folderName: "资料" },
                  },
                ]
              : [
                  {
                    id: 20,
                    content: {
                      name: "课件.pdf",
                      objectId: "obj-20",
                      size: "4096",
                      uploadDate: "1780191356415",
                    },
                  },
                ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    return new Response("", { status: 404 })
  }) as typeof fetch

  try {
    const createRes = await app.request(
      "/api/admin/storage/create",
      {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          driver: "ChaoXingGroupDrive",
          mount_path: "/chaoxing",
          addition: JSON.stringify({
            user_name: "13800138000",
            password: "secret",
            bbsid: "bbs-123",
            root_folder_id: "-1",
          }),
        }),
      },
      env,
    )
    assert.equal(createRes.status, 200)
    const created: any = await createRes.json()
    assert.equal(created.code, 200)
    assert.equal(created.data.driver, "ChaoXingGroupDrive")

    const dbAfterCreate: any = await getDb(env)
    const createdStorage = dbAfterCreate.storages.find(
      (s: any) => s.id === created.data.id,
    )
    assert.equal(
      JSON.parse(createdStorage.addition).cookie,
      "UID=cx-cookie-1; fid=100",
    )

    // 确保 modified 时间戳推进，让 /storage/update 触发重新 init 与 deferredTokenPersistence
    await new Promise((r) => setTimeout(r, 5))

    const updateRes = await app.request(
      "/api/admin/storage/update",
      {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          id: created.data.id,
          driver: "ChaoXingGroupDrive",
          mount_path: "/chaoxing",
          addition: JSON.stringify({
            user_name: "13800138000",
            password: "secret",
            bbsid: "bbs-123",
            root_folder_id: "root-cx-99",
            cookie: "",
          }),
        }),
      },
      env,
    )
    assert.equal(updateRes.status, 200)
    const updatedBody: any = await updateRes.json()
    assert.equal(updatedBody.code, 200)

    const dbAfterUpdate: any = await getDb(env)
    const updatedStorage = dbAfterUpdate.storages.find(
      (s: any) => s.id === created.data.id,
    )
    const updatedAdd = JSON.parse(updatedStorage.addition)
    assert.equal(updatedAdd.root_folder_id, "root-cx-99")
    assert.equal(updatedAdd.cookie, "UID=cx-cookie-2; fid=100")

    const { content, provider } = await listItems("/chaoxing", { env })
    assert.equal(provider, "ChaoXingGroupDrive")
    assert.ok(content.some((i) => i.name === "资料" && i.is_dir))
    assert.ok(content.some((i) => i.name === "课件.pdf" && !i.is_dir))
  } finally {
    globalThis.fetch = originalFetch
  }
})
