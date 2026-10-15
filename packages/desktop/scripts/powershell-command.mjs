const POWERSHELL_COMMON_ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive"];

const WINDOWS_POWERSHELL_SECURITY_BOOTSTRAP = [
  "$ErrorActionPreference='Stop';",
  "try{",
  "$zcodeSecurityModule=[IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Security','Microsoft.PowerShell.Security.psd1');",
  "Import-Module -Name $zcodeSecurityModule -Force -ErrorAction Stop;",
  "}catch{",
  "[Console]::Error.WriteLine(('Windows PowerShell Security module load failed: {0}' -f $_.Exception.Message));",
  "exit 26;",
  "};",
].join("");

function encodeUtf8Value(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

export function createEncodedPowerShellArgs(script, values = []) {
  // Windows PowerShell 5.1 会把普通 `-Command` 后续 argv 拼回命令文本，
  // 不会把它们注入 `$args`。动态值先单独编码，再放进 `-EncodedCommand`，同时避免
  // Program Files 空格、引号或分号被 PowerShell 二次解析成脚本内容。
  const valueBindings = values
    .map(
      (value, index) =>
        `$zcodeArg${index}=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodeUtf8Value(value)}'));`,
    )
    .join("");
  // 修复原因：Windows PowerShell 5.1 的 [Console]::Out 默认按系统 OEM 代码页写 stdout
  //（如俄文机器 CP866、繁中机器 CP950），而所有调用方（chromeCredentialManager、
  // windowsAumidIcon、windowsChromeAppBoundKey 及其单测）一律按 UTF-8 解码输出，
  // 代码页外的非 ASCII 字符（中文路径等）会被 PowerShell 替换成 "?"。
  // 在脚本入口把控制台输出编码切换为 UTF-8，保证双向编码一致。
  const outputEncodingSetup = "[Console]::OutputEncoding=[Text.Encoding]::UTF8;";
  const encodedCommand = Buffer.from(
    `${outputEncodingSetup}${valueBindings}${script}`,
    "utf16le",
  ).toString("base64");
  return [...POWERSHELL_COMMON_ARGS, "-EncodedCommand", encodedCommand];
}

export function createWindowsPowerShellSecurityArgs(script, values = []) {
  // 由 pwsh 启动的 Node 会继承 PowerShell 7 的 PSModulePath，随后再启动
  // Windows PowerShell 5.1 时可能错误发现不兼容的 Security 模块。直接从当前
  // powershell.exe 的 PSHOME 加载系统模块，避免把外部环境变量当作模块信任根。
  return createEncodedPowerShellArgs(`${WINDOWS_POWERSHELL_SECURITY_BOOTSTRAP}${script}`, values);
}
