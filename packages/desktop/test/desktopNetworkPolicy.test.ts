import forge from "node-forge";
import { describe, expect, it, vi } from "vitest";
import type { Session } from "electron";
import {
  applyDesktopChromiumNetworkPolicies,
  applyDesktopSessionNetworkPolicy,
  buildElectronProxyConfig,
  createCustomCaCertificateVerifyProc,
  readCustomCaCertificatesFromPem,
} from "../src/main/desktopNetworkPolicy.js";
import { EMBEDDED_BROWSER_PARTITION } from "../src/main/browserDataManager.js";

// desktopNetworkPolicy now reads autoUpdater.netSession at module load to include the
// auto-updater session in the startup policy. Importing the real electron-updater in the
// bare Node test environment constructs an updater whose app adapter has no electron app,
// so stub the module with a dedicated net session stub instead.
const electronUpdaterMocks = vi.hoisted(() => ({
  netSession: {
    setProxy: vi.fn(async () => {}),
    closeAllConnections: vi.fn(async () => {}),
    setCertificateVerifyProc: vi.fn(),
  },
}));

vi.mock("electron-updater", () => ({
  default: {
    autoUpdater: {
      netSession: electronUpdaterMocks.netSession,
    },
  },
}));

describe("desktopNetworkPolicy", () => {
  it("applies the startup network policy only to the default, auto-updater and embedded Browser sessions", async () => {
    const defaultSession = createSessionStub();
    const embeddedBrowserSession = createSessionStub();
    const codingPlanSession = createSessionStub();
    const sessionProvider = {
      defaultSession: defaultSession.session,
      fromPartition: vi.fn((partition: string) =>
        partition === EMBEDDED_BROWSER_PARTITION
          ? embeddedBrowserSession.session
          : codingPlanSession.session,
      ),
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };

    await applyDesktopChromiumNetworkPolicies(
      sessionProvider,
      {
        httpProxy: "http://127.0.0.1:7890",
        httpProxyNoProxy: "localhost,127.0.0.1",
      },
      logger,
    );

    expect(sessionProvider.fromPartition).toHaveBeenCalledTimes(1);
    expect(sessionProvider.fromPartition).toHaveBeenCalledWith(EMBEDDED_BROWSER_PARTITION);
    for (const target of [defaultSession, embeddedBrowserSession]) {
      expect(target.setProxy).toHaveBeenCalledWith({
        mode: "fixed_servers",
        proxyBypassRules: "localhost,127.0.0.1",
        proxyRules: "http://127.0.0.1:7890",
      });
      expect(target.closeAllConnections).toHaveBeenCalledTimes(1);
      expect(target.setCertificateVerifyProc).toHaveBeenCalledWith(null);
    }
    // v3.18 routes update downloads through the auto-updater's own net session;
    // the startup policy must reach it too, otherwise the settings proxy and CA
    // would not apply to update downloads.
    expect(electronUpdaterMocks.netSession.setProxy).toHaveBeenCalledWith({
      mode: "fixed_servers",
      proxyBypassRules: "localhost,127.0.0.1",
      proxyRules: "http://127.0.0.1:7890",
    });
    expect(electronUpdaterMocks.netSession.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(electronUpdaterMocks.netSession.setCertificateVerifyProc).toHaveBeenCalledWith(null);
    expect(codingPlanSession.setProxy).not.toHaveBeenCalled();
  });

  it("falls back to the system proxy only on the embedded Browser session when the setting is empty", async () => {
    const defaultSession = createSessionStub();
    const embeddedBrowserSession = createSessionStub();
    const sessionProvider = {
      defaultSession: defaultSession.session,
      fromPartition: vi.fn(() => embeddedBrowserSession.session),
    };
    const logger = { info: vi.fn(), warn: vi.fn() };

    await applyDesktopChromiumNetworkPolicies(sessionProvider, {}, logger);

    // Bug 原因：留空曾被翻译成 `direct`，而 Electron 的 `direct` 是「永不使用代理」，
    // 会连本机系统代理一起屏蔽。内置浏览器是用户的浏览出口，需要代理才能访问的站点
    // 会直接 ERR_CONNECTION_TIMED_OUT，与用户本机浏览器行为漂移。
    expect(embeddedBrowserSession.setProxy).toHaveBeenCalledWith({ mode: "system" });
    // defaultSession 承载 ZCode 自身的后端与模型流量，留空时保持显式收敛，不受系统代理影响。
    expect(defaultSession.setProxy).toHaveBeenCalledWith({ mode: "direct" });
  });

  it("continues configuring the embedded Browser session when the default session fails", async () => {
    const defaultError = new Error("default session proxy failed");
    const defaultSession = createSessionStub({ setProxyError: defaultError });
    const embeddedBrowserSession = createSessionStub();
    const sessionProvider = {
      defaultSession: defaultSession.session,
      fromPartition: vi.fn(() => embeddedBrowserSession.session),
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };

    await applyDesktopChromiumNetworkPolicies(sessionProvider, {}, logger);

    expect(defaultSession.closeAllConnections).not.toHaveBeenCalled();
    expect(embeddedBrowserSession.setProxy).toHaveBeenCalledWith({ mode: "system" });
    expect(embeddedBrowserSession.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(embeddedBrowserSession.setCertificateVerifyProc).toHaveBeenCalledWith(null);
    expect(logger.warn).toHaveBeenCalledWith(
      "[desktop-network] default-session network policy apply failed:",
      defaultError,
    );
  });

  it("accepts every certificate on the embedded Browser session when insecure certificates are allowed", async () => {
    const defaultSession = createSessionStub();
    const embeddedBrowserSession = createSessionStub();
    const sessionProvider = {
      defaultSession: defaultSession.session,
      fromPartition: vi.fn(() => embeddedBrowserSession.session),
    };
    const logger = { info: vi.fn(), warn: vi.fn() };

    await applyDesktopChromiumNetworkPolicies(
      sessionProvider,
      { embeddedBrowserAllowInsecureCertificates: true },
      logger,
    );

    const embeddedProc = embeddedBrowserSession.setCertificateVerifyProc.mock.calls.at(0)?.[0];
    expect(embeddedProc).toBeTypeOf("function");
    const results: number[] = [];
    embeddedProc?.(
      buildVerifyRequest(generateSelfSignedCertPem("Untrusted Intranet")),
      (result: number) => results.push(result),
    );
    expect(results).toEqual([0]);
  });

  it("keeps the default session on strict verification when insecure certificates are allowed", async () => {
    const defaultSession = createSessionStub();
    const embeddedBrowserSession = createSessionStub();
    const sessionProvider = {
      defaultSession: defaultSession.session,
      fromPartition: vi.fn(() => embeddedBrowserSession.session),
    };
    const logger = { info: vi.fn(), warn: vi.fn() };

    await applyDesktopChromiumNetworkPolicies(
      sessionProvider,
      { embeddedBrowserAllowInsecureCertificates: true },
      logger,
    );

    // 放行只属于内置浏览器出口；defaultSession 承载 ZCode 自身的后端与模型流量，必须保持严格校验。
    expect(defaultSession.setCertificateVerifyProc).toHaveBeenCalledWith(null);
  });

  it("keeps every session on strict verification when insecure certificates are disabled", async () => {
    const defaultSession = createSessionStub();
    const embeddedBrowserSession = createSessionStub();
    const sessionProvider = {
      defaultSession: defaultSession.session,
      fromPartition: vi.fn(() => embeddedBrowserSession.session),
    };
    const logger = { info: vi.fn(), warn: vi.fn() };

    await applyDesktopChromiumNetworkPolicies(
      sessionProvider,
      { embeddedBrowserAllowInsecureCertificates: false },
      logger,
    );

    expect(defaultSession.setCertificateVerifyProc).toHaveBeenCalledWith(null);
    expect(embeddedBrowserSession.setCertificateVerifyProc).toHaveBeenCalledWith(null);
  });

  it("prefers blanket acceptance over the custom CA chain check when both are configured", async () => {
    const targetSession = createSessionStub();
    const logger = { info: vi.fn(), warn: vi.fn() };

    await applyDesktopSessionNetworkPolicy(
      targetSession.session,
      { httpProxyCaCertPath: "/definitely/missing/root-ca.pem" },
      logger,
      { allowInsecureCertificates: true },
    );

    const proc = targetSession.setCertificateVerifyProc.mock.calls.at(0)?.[0];
    expect(proc).toBeTypeOf("function");
    const results: number[] = [];
    proc?.(buildVerifyRequest(generateSelfSignedCertPem("Intranet")), (result: number) =>
      results.push(result),
    );
    expect(results).toEqual([0]);
  });

  it("builds a fixed-server proxy config from the explicit setting", () => {
    expect(
      buildElectronProxyConfig("127.0.0.1:7890", " localhost, 127.0.0.1 ,.example.com "),
    ).toEqual({
      mode: "fixed_servers",
      proxyBypassRules: "localhost,127.0.0.1,.example.com",
      proxyRules: "http://127.0.0.1:7890",
    });
  });

  it("uses direct mode when the explicit proxy setting is empty", () => {
    expect(buildElectronProxyConfig(" ")).toEqual({ mode: "direct" });
  });

  it("falls back to the requested mode when the explicit proxy setting is empty", () => {
    expect(buildElectronProxyConfig(" ", "localhost", "system")).toEqual({ mode: "system" });
  });

  it("keeps the explicit proxy config regardless of the fallback mode", () => {
    // 兜底模式只在留空时生效；显式代理仍必须原样落到 fixed_servers，避免设置页配置被系统代理顶掉。
    expect(buildElectronProxyConfig("127.0.0.1:7890", "localhost", "system")).toEqual({
      mode: "fixed_servers",
      proxyBypassRules: "localhost",
      proxyRules: "http://127.0.0.1:7890",
    });
  });

  it("accepts only certificate chains that include the configured custom CA", async () => {
    // v3.18 replaced raw fingerprint matching with full chain validation; drive the
    // verify proc with a CA-issued leaf and an unrelated self-signed certificate.
    const caKeys = forge.pki.rsa.generateKeyPair(2048);
    const caCert = createTestCertificate({
      commonName: "Trusted Test CA",
      keys: caKeys,
      isCa: true,
    });
    const caPem = forge.pki.certificateToPem(caCert);
    const trustedLeafPem = forge.pki.certificateToPem(
      createTestCertificate({
        commonName: "intranet.test",
        keys: forge.pki.rsa.generateKeyPair(2048),
        issuerCert: caCert,
        issuerKeys: caKeys,
        dnsNames: ["intranet.test"],
      }),
    );
    const untrustedPem = generateSelfSignedCertPem("Other Test CA", {
      dnsNames: ["other.test"],
    });
    const trustedCertificates = readCustomCaCertificatesFromPem(caPem);
    const proc = createCustomCaCertificateVerifyProc(trustedCertificates);
    const acceptedResults: number[] = [];
    const rejectedResults: number[] = [];

    expect(proc).not.toBeNull();
    // The v3.18 proc verifies the chain asynchronously; both callbacks are awaited below.
    proc?.(buildVerifyRequest(trustedLeafPem), (result) => acceptedResults.push(result));
    proc?.(buildVerifyRequest(untrustedPem), (result) => rejectedResults.push(result));
    await vi.waitFor(() => {
      expect(acceptedResults).toEqual([0]);
      expect(rejectedResults).toEqual([-3]);
    });
  });
});

function createSessionStub(options: { setProxyError?: Error } = {}) {
  const setProxy = vi.fn(async () => {
    if (options.setProxyError) throw options.setProxyError;
  });
  const closeAllConnections = vi.fn(async () => {});
  const setCertificateVerifyProc = vi.fn();
  return {
    session: {
      setProxy,
      closeAllConnections,
      setCertificateVerifyProc,
    } as unknown as Session,
    setProxy,
    closeAllConnections,
    setCertificateVerifyProc,
  };
}

type VerifyRequest = Parameters<NonNullable<Parameters<Session["setCertificateVerifyProc"]>[0]>>[0];

/** 构造一条「Chromium 已判定证书不受信」的校验请求，用于驱动 verifyProc 的拒绝分支。 */
function buildVerifyRequest(certPem: string): VerifyRequest {
  return {
    certificate: { data: certPem, issuerCert: null },
    hostname: "intranet.test",
    isIssuedByKnownRoot: false,
    validatedCertificate: { data: certPem, issuerCert: null },
    verificationResult: "CERT_AUTHORITY_INVALID",
    errorCode: -202,
  } as unknown as VerifyRequest;
}

interface TestCertificateOptions {
  commonName: string;
  keys: ReturnType<typeof forge.pki.rsa.generateKeyPair>;
  issuerCert?: forge.pki.Certificate;
  issuerKeys?: ReturnType<typeof forge.pki.rsa.generateKeyPair>;
  isCa?: boolean;
  dnsNames?: string[];
}

/**
 * Builds a 2048-bit test certificate. The v3.18 custom CA validator rejects
 * certificates signed with keys narrower than 2048 bits, so the old 1024-bit
 * generator would fail even the trusted-chain path.
 */
function createTestCertificate(options: TestCertificateOptions): forge.pki.Certificate {
  const cert = forge.pki.createCertificate();
  cert.publicKey = options.keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date("2026-01-01T00:00:00Z");
  cert.validity.notAfter = new Date("2036-01-01T00:00:00Z");
  const subjectAttrs = [{ name: "commonName", value: options.commonName }];
  cert.setSubject(subjectAttrs);
  cert.setIssuer(options.issuerCert ? options.issuerCert.subject.attributes : subjectAttrs);
  const extensions: Array<Record<string, unknown>> = [
    { name: "basicConstraints", cA: options.isCa === true, critical: true },
    {
      name: "keyUsage",
      critical: true,
      digitalSignature: options.isCa !== true,
      keyCertSign: options.isCa === true,
    },
  ];
  if (options.dnsNames?.length) {
    extensions.push({
      name: "subjectAltName",
      altNames: options.dnsNames.map((dnsName) => ({ type: 2, value: dnsName })),
    });
  }
  cert.setExtensions(extensions as never);
  cert.sign(
    (options.issuerKeys ?? options.keys).privateKey,
    forge.md.sha256.create(),
  );
  return cert;
}

function generateSelfSignedCertPem(
  commonName: string,
  options: { dnsNames?: string[] } = {},
): string {
  return forge.pki.certificateToPem(
    createTestCertificate({
      commonName,
      keys: forge.pki.rsa.generateKeyPair(2048),
      dnsNames: options.dnsNames,
    }),
  );
}
