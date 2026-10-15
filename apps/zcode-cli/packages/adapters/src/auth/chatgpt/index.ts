/**
 * Sign in with ChatGPT（OpenAI token sharing）授权模块。
 *
 * 选择性移植自 nasone32/ZCode feat/chatgpt-oauth（commit bd5171cb，
 * docs/chatgpt-oauth.md），并按本仓库计划 docs/spec-harness/CHATGPT-SUBSCRIPTION-PLAN.md
 * §3/§4 重做：跨进程 refresh 在网络请求前串行化、单键原子持久化、earliest_refresh_at
 * 严格合规、scope 缺失时保留登录但推理 fail-closed。不包含该 fork 的 Z.ai 路由 /
 * retry / provider registry 改动。
 */
export * from "./chatgpt-oauth-protocol.js";
export * from "./pkce.js";
export * from "./chatgpt-oauth-client.js";
export * from "./chatgpt-id-token.js";
export * from "./chatgpt-credential-record.js";
export * from "./chatgpt-refresh-coordinator.js";
export * from "./chatgpt-request-auth.js";
export * from "./chatgpt-login-flow.js";
export * from "./chatgpt-model-refresh.js";
