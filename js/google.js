// Google 連携（Google Identity Services でトークン取得 → Gmail / Drive の REST API を直接呼ぶ）

export const SCOPES = {
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
  // drive.file: このアプリが作成したファイルだけにアクセスできる最小権限
  drive: 'https://www.googleapis.com/auth/drive.file',
};

export const BACKUP_FILE_NAME = 'tcg-collection-backup.json';

let gisPromise = null;
const tokens = {}; // scope → { token, exp }

// GIS スクリプトの読み込み（ポップアップがブロックされないよう、起動時に先読みしておく）
export function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { gisPromise = null; reject(new Error('Googleログイン用スクリプトを読み込めませんでした')); };
      document.head.appendChild(s);
    });
  }
  return gisPromise;
}

export function hasToken(scope) {
  const t = tokens[scope];
  return !!t && t.exp > Date.now() + 60_000;
}

export async function getToken(scope, clientId) {
  if (!clientId) throw new Error('設定画面で Google OAuth クライアントID を入力してください');
  if (hasToken(scope)) return tokens[scope].token;
  await loadGis();
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope,
      callback: (resp) => {
        if (resp.error) { reject(new Error(authErrorMessage(resp.error, resp.error_description))); return; }
        // 同意画面で権限のチェックを外して許可された場合はトークンを使わない
        if (!window.google.accounts.oauth2.hasGrantedAllScopes(resp, scope)) {
          reject(new Error(`${scopeLabel(scope)}の権限が許可されていません。もう一度実行し、Google の確認画面で「${scopeLabel(scope)}」にチェックを入れて「続行」を押してください。`));
          return;
        }
        tokens[scope] = { token: resp.access_token, exp: Date.now() + Number(resp.expires_in || 3600) * 1000 };
        needConsent.delete(scope);
        resolve(resp.access_token);
      },
      error_callback: (err) => reject(new Error(
        err?.type === 'popup_closed' ? 'Google のログイン画面が閉じられました'
          : err?.type === 'popup_failed_to_open' ? 'ログイン用のポップアップがブロックされました。ブラウザでこのサイトのポップアップを許可してください'
            : err?.message || err?.type || '認証がキャンセルされました',
      )),
    });
    // 権限不足で失敗した後は、権限の確認画面を必ず表示させる
    client.requestAccessToken({ prompt: needConsent.has(scope) ? 'consent' : '' });
  });
}

const needConsent = new Set();
const scopeLabel = (scope) => (scope === SCOPES.gmail ? 'Gmail の閲覧' : scope === SCOPES.drive ? 'Google ドライブのファイル' : '必要');

function authErrorMessage(code, desc) {
  if (code === 'access_denied') return 'Google へのアクセスが拒否されました。OAuth 同意画面の「テストユーザー」に、ログインに使う Gmail アドレスが追加されているか確認してください';
  if (code === 'invalid_client' || code === 'unauthorized_client') return 'OAuth クライアントID が正しくありません。設定画面のクライアントIDを確認してください';
  if (/origin/i.test(desc || '')) return `このサイト（${location.origin}）が OAuth クライアントの「承認済みの JavaScript 生成元」に登録されていません`;
  return `Google ログインエラー: ${desc || code}`;
}

// Google API のエラー応答を、原因と対処が分かる日本語にする
function apiErrorMessage(status, err, url) {
  const msg = err?.message || '';
  const reasons = [
    ...(err?.errors || []).map((e) => e.reason),
    ...(err?.details || []).map((d) => d.reason),
    err?.status,
  ].filter(Boolean).join(' ');
  const api = String(url).includes('gmail') ? 'Gmail API' : 'Google Drive API';
  if (/SERVICE_DISABLED|accessNotConfigured/i.test(reasons) || /has not been used|is disabled/i.test(msg)) {
    return `${api} が有効になっていません。Google Cloud Console の「APIとサービス → ライブラリ」で ${api} を有効にし、数分待ってから再実行してください。`;
  }
  if (/SCOPE_INSUFFICIENT|insufficientPermissions/i.test(reasons) || /insufficient authentication scopes/i.test(msg)) {
    return `${api} を使う権限が許可されていません。もう一度実行すると Google の確認画面が出るので、すべての項目にチェックを入れて許可してください。`;
  }
  if (status === 401) return 'Google のログインの有効期限が切れました。もう一度実行してください。';
  if (status === 429 || /rateLimitExceeded|RESOURCE_EXHAUSTED/i.test(reasons)) return 'Google API の利用回数の上限に達しました。少し時間をおいて再実行してください。';
  return `Google API エラー（${status}）: ${msg || reasons || '詳細不明'}`;
}

async function gfetch(url, token, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  if (res.ok) return res;
  let err = null;
  try { err = (await res.json()).error; } catch { /* 本文なし */ }
  const reasons = JSON.stringify(err || {});
  if (res.status === 401 || res.status === 403) {
    // トークンを破棄し、権限不足なら次回は確認画面から出し直す
    Object.keys(tokens).forEach((k) => {
      if (tokens[k].token !== token) return;
      delete tokens[k];
      if (res.status === 403 && /SCOPE_INSUFFICIENT|insufficient/i.test(reasons)) needConsent.add(k);
    });
  }
  console.error('Google API エラー', res.status, err);
  throw new Error(apiErrorMessage(res.status, err, url));
}

// ---------- Gmail ----------

export async function gmailSearch(token, q, max = 200) {
  const ids = [];
  let pageToken = '';
  do {
    const u = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    u.searchParams.set('q', q);
    u.searchParams.set('maxResults', String(Math.min(100, max)));
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const j = await (await gfetch(u, token)).json();
    (j.messages || []).forEach((m) => ids.push(m));
    pageToken = j.nextPageToken || '';
  } while (pageToken && ids.length < max);
  return ids.slice(0, max);
}

// base64url → 文字列（パートの charset に従ってデコード。ISO-2022-JP のメールにも対応）
function decodeBody(data, charset) {
  const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function headerOf(headers, name) {
  return (headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

function charsetOf(part) {
  const m = headerOf(part.headers, 'Content-Type').match(/charset="?([^";\s]+)"?/i);
  return m ? m[1] : 'utf-8';
}

function findPart(part, mime) {
  if (!part) return null;
  if (part.mimeType === mime && part.body?.data) return part;
  for (const p of part.parts || []) {
    const f = findPart(p, mime);
    if (f) return f;
  }
  return null;
}

// HTML メールをプレーンテキスト化（GAS の getPlainBody 相当）
function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n'), 'text/html');
  return doc.body?.textContent || '';
}

export async function gmailGet(token, id) {
  const j = await (await gfetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, token)).json();
  const plain = findPart(j.payload, 'text/plain');
  const html = findPart(j.payload, 'text/html');
  let body = '';
  if (plain) body = decodeBody(plain.body.data, charsetOf(plain));
  else if (html) body = htmlToText(decodeBody(html.body.data, charsetOf(html)));
  return {
    id: j.id,
    threadId: j.threadId,
    date: new Date(Number(j.internalDate)),
    subject: headerOf(j.payload?.headers, 'Subject'),
    body,
    link: `https://mail.google.com/mail/u/0/#all/${j.threadId}`,
  };
}

// ---------- Google Drive ----------

async function findBackupFile(token) {
  const u = new URL('https://www.googleapis.com/drive/v3/files');
  u.searchParams.set('q', `name='${BACKUP_FILE_NAME}' and trashed=false`);
  u.searchParams.set('fields', 'files(id,name,modifiedTime)');
  u.searchParams.set('orderBy', 'modifiedTime desc');
  const j = await (await gfetch(u, token)).json();
  return j.files?.[0] || null;
}

// 写真を含むと数十MBになるため、5MB 制限のない resumable upload で保存する
export async function driveSave(token, data) {
  const content = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const file = await findBackupFile(token);
  const url = file
    ? `https://www.googleapis.com/upload/drive/v3/files/${file.id}?uploadType=resumable&fields=id,modifiedTime`
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,modifiedTime';
  // 1. アップロードセッションを開始
  const init = await gfetch(url, token, {
    method: file ? 'PATCH' : 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'application/json',
      'X-Upload-Content-Length': String(content.size),
    },
    body: JSON.stringify(file ? {} : { name: BACKUP_FILE_NAME, mimeType: 'application/json' }),
  });
  const session = init.headers.get('Location');
  if (!session) throw new Error('Googleドライブのアップロードを開始できませんでした');
  // 2. 本体を送信（セッションURLは認証不要）
  const res = await fetch(session, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: content });
  if (!res.ok) throw new Error(`Googleドライブへの保存に失敗しました (${res.status})`);
  return res.json();
}

export async function driveLoad(token) {
  const file = await findBackupFile(token);
  if (!file) return null;
  const res = await gfetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, token);
  return { data: await res.json(), modifiedTime: file.modifiedTime };
}
