/**
 * 黑猪模式 — 包根模块（宿主半边）。
 *
 * 本包原本只提供子路径模块（`blackpig-roster.mjs` / `guard-v10.mjs` /
 * `subtalk.mjs` / `file-info.mjs`），Loader 行写的都是子路径。
 *
 * 但宿主的客户端发现只认**裸包名**行：
 * `@deepseek-ai/dsh-client-modules` 的 `exactPackageSpecifier()` 对含 `/`
 * 的 specifier 一律返回 `undefined`，于是子路径行根本不参与 `dsh.client`
 * 扫描 ⇒ `lib/client.js` 永远不会进 `window.__DSH_BOOT__`。
 *
 * 所以本包补了一个裸名行（`cordis.patch.yml` 里 `name: dsh-blackpig-mode`）
 * 指向这里；这里做两件事：无宿主行为。真正的内容全是子路径行原有的。
 * 详见 docs/blackpig-mode-notes.md。
 *
 * @module dsh-blackpig-mode
 */

/** 宿主侧无新增行为：本模块只为让客户端的 `dsh.client` 声明被发现。 */
export function apply() {}
