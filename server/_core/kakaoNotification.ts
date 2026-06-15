import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ENV } from "./env";

type KakaoTokenStore = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
};

const TOKEN_STORE_PATH = path.resolve(process.cwd(), ".data", "kakao-token.json");

async function ensureTokenDir() {
  await mkdir(path.dirname(TOKEN_STORE_PATH), { recursive: true });
}

async function loadTokenStore(): Promise<KakaoTokenStore> {
  try {
    const raw = await readFile(TOKEN_STORE_PATH, "utf-8");
    return JSON.parse(raw) as KakaoTokenStore;
  } catch {
    return {};
  }
}

async function saveTokenStore(store: KakaoTokenStore) {
  await ensureTokenDir();
  await writeFile(TOKEN_STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

function hasKakaoConfig() {
  return Boolean(
    ENV.kakaoRestApiKey &&
      (ENV.kakaoRefreshToken || ENV.kakaoAccessToken)
  );
}

function isTokenValid(token?: string, expiresAt?: number) {
  if (!token) {
    return false;
  }

  if (!expiresAt) {
    return true;
  }

  return Date.now() < expiresAt - 60_000;
}

async function refreshAccessToken(refreshToken: string): Promise<KakaoTokenStore | null> {
  if (!ENV.kakaoRestApiKey) {
    return null;
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: ENV.kakaoRestApiKey,
    refresh_token: refreshToken,
  });

  if (ENV.kakaoClientSecret) {
    body.set("client_secret", ENV.kakaoClientSecret);
  }

  const response = await fetch("https://kauth.kakao.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
    },
    body,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.warn(
      `[Kakao] Failed to refresh access token (${response.status} ${response.statusText})${
        detail ? `: ${detail}` : ""
      }`
    );
    return null;
  }

  const json = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
  };

  if (!json.access_token) {
    return null;
  }

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || refreshToken,
    expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : undefined,
  };
}

async function resolveAccessToken(): Promise<string | null> {
  const fileStore = await loadTokenStore();
  const envAccessToken = ENV.kakaoAccessToken || fileStore.accessToken;
  const envRefreshToken = ENV.kakaoRefreshToken || fileStore.refreshToken;
  const expiresAt = fileStore.expiresAt;

  if (isTokenValid(envAccessToken, expiresAt)) {
    return envAccessToken || null;
  }

  if (!envRefreshToken) {
    return envAccessToken || null;
  }

  const refreshed = await refreshAccessToken(envRefreshToken);
  if (!refreshed?.accessToken) {
    return envAccessToken || null;
  }

  await saveTokenStore(refreshed);
  return refreshed.accessToken;
}

export async function sendKakaoMemo(title: string, content: string): Promise<boolean> {
  if (!hasKakaoConfig()) {
    return false;
  }

  const accessToken = await resolveAccessToken();
  if (!accessToken) {
    console.warn("[Kakao] Access token is unavailable.");
    return false;
  }

  const templateObject = {
    object_type: "text",
    text: `${title}\n\n${content}`.slice(0, 1000),
    link: {
      web_url: ENV.kakaoWebUrl || "http://localhost:3001/dashboard/analysis",
      mobile_web_url: ENV.kakaoWebUrl || "http://localhost:3001/dashboard/analysis",
    },
    button_title: "분석 보기",
  };

  const body = new URLSearchParams({
    template_object: JSON.stringify(templateObject),
  });

  const response = await fetch("https://kapi.kakao.com/v2/api/talk/memo/default/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
    },
    body,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.warn(
      `[Kakao] Failed to send memo (${response.status} ${response.statusText})${
        detail ? `: ${detail}` : ""
      }`
    );
    return false;
  }

  return true;
}
