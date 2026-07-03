import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pkceChallenge from "pkce-challenge";
import { createOAuthProvider, type OAuthProvider } from "../src/oauth.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

function fakeRes() {
  const state = { statusCode: 200, body: "", redirectedTo: undefined as string | undefined };
  const res: any = {
    status(code: number) {
      state.statusCode = code;
      return res;
    },
    type() {
      return res;
    },
    send(body: string) {
      state.body = body;
      return res;
    },
    redirect(code: number, url: string) {
      state.statusCode = code;
      state.redirectedTo = url;
      return res;
    },
  };
  return { res, state };
}

const CLIENT: OAuthClientInformationFull = {
  client_id: "client-1",
  redirect_uris: ["https://client.example/callback"],
  client_name: "Test Client",
};

describe("OAuth 2.1 provider", () => {
  let provider: OAuthProvider;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    provider = createOAuthProvider({ serverUrl: "https://aac.example" });
    provider.clientsStore.registerClient!(CLIENT);
    fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    provider.stop();
    vi.unstubAllGlobals();
  });

  async function runFullFlow(aacToken: string) {
    const pkce = await pkceChallenge();
    const { res: authRes, state: authState } = fakeRes();
    await provider.authorize(CLIENT, { state: "xyz", scopes: ["aacworkflow"], redirectUri: CLIENT.redirect_uris[0]!, codeChallenge: pkce.code_challenge }, authRes);
    const txn = /name="txn" value="([^"]+)"/.exec(authState.body)?.[1];
    expect(txn).toBeTruthy();

    fetchMock.mockImplementationOnce(async (url: string | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      const ok = headers.Authorization === `Bearer ${aacToken}`;
      return new Response(null, { status: ok ? 200 : 401 });
    });

    const { res: verifyRes, state: verifyState } = fakeRes();
    await provider.completeAuthorization(txn!, aacToken, verifyRes);
    return { verifyState, pkce };
  }

  it("completes authorize -> verify -> code exchange -> access token", async () => {
    const { verifyState, pkce } = await runFullFlow("mul_good_token");
    expect(verifyState.redirectedTo).toMatch(/^https:\/\/client\.example\/callback\?code=/);
    const redirectUrl = new URL(verifyState.redirectedTo!);
    expect(redirectUrl.searchParams.get("state")).toBe("xyz");
    const code = redirectUrl.searchParams.get("code")!;

    const challenge = await provider.challengeForAuthorizationCode(CLIENT, code);
    expect(challenge).toBe(pkce.code_challenge);

    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code, pkce.code_verifier, CLIENT.redirect_uris[0]);
    expect(tokens.access_token).toMatch(/^aacmcp_at_/);
    expect(tokens.refresh_token).toMatch(/^aacmcp_rt_/);

    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.extra?.aacToken).toBe("mul_good_token");
    expect(info.clientId).toBe(CLIENT.client_id);

    // Codes are single-use.
    await expect(provider.exchangeAuthorizationCode(CLIENT, code, pkce.code_verifier, CLIENT.redirect_uris[0])).rejects.toThrow(InvalidGrantError);
  });

  it("re-renders the consent page with an error when the pasted token is rejected", async () => {
    const pkce = await pkceChallenge();
    const { res: authRes, state: authState } = fakeRes();
    await provider.authorize(CLIENT, { redirectUri: CLIENT.redirect_uris[0]!, codeChallenge: pkce.code_challenge }, authRes);
    const txn = /name="txn" value="([^"]+)"/.exec(authState.body)?.[1]!;

    fetchMock.mockImplementationOnce(async () => new Response(null, { status: 401 }));
    const { res: verifyRes, state: verifyState } = fakeRes();
    await provider.completeAuthorization(txn, "mul_bad_token", verifyRes);

    expect(verifyState.redirectedTo).toBeUndefined();
    expect(verifyState.body).toMatch(/rejected/);
  });

  it("rejects a submission for an unknown/expired transaction", async () => {
    const { res, state } = fakeRes();
    await provider.completeAuthorization("does-not-exist", "mul_x", res);
    expect(state.statusCode).toBe(400);
    expect(state.body).toMatch(/expired/);
  });

  it("legacy pass-through accepts a raw mul_ bearer token directly", async () => {
    const info = await provider.verifyAccessToken("mul_some_raw_token");
    expect(info.extra?.aacToken).toBe("mul_some_raw_token");
    expect(info.clientId).toBe("legacy-direct-token");
  });

  it("rejects unknown, non-mul_ tokens", async () => {
    await expect(provider.verifyAccessToken("garbage")).rejects.toThrow(InvalidTokenError);
  });

  it("revokeToken makes an access token invalid", async () => {
    const { verifyState, pkce } = await runFullFlow("mul_good_token");
    const code = new URL(verifyState.redirectedTo!).searchParams.get("code")!;
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code, pkce.code_verifier, CLIENT.redirect_uris[0]);

    await provider.revokeToken!(CLIENT, { token: tokens.access_token! });
    await expect(provider.verifyAccessToken(tokens.access_token!)).rejects.toThrow(InvalidTokenError);
  });

  it("exchangeRefreshToken issues a new access token and rotates the refresh token", async () => {
    const { verifyState, pkce } = await runFullFlow("mul_good_token");
    const code = new URL(verifyState.redirectedTo!).searchParams.get("code")!;
    const tokens = await provider.exchangeAuthorizationCode(CLIENT, code, pkce.code_verifier, CLIENT.redirect_uris[0]);

    const refreshed = await provider.exchangeRefreshToken(CLIENT, tokens.refresh_token!);
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    const info = await provider.verifyAccessToken(refreshed.access_token);
    expect(info.extra?.aacToken).toBe("mul_good_token");

    await expect(provider.exchangeRefreshToken(CLIENT, tokens.refresh_token!)).rejects.toThrow(InvalidGrantError);
  });
});
