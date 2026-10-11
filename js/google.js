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
        if (resp.error) { reject(new Error(resp.error_description || resp.error)); return; }
        tokens[scope] = { token: resp.access_token, exp: Date.now() + Number(resp.expires_in || 3600) * 1000 };
        resolve(resp.access_token);
      },
      error_callback: (err) => reject(new Error(err?.message || err?.type || '認証がキャンセルされました')),
    });
    client.requestAccessToken({ prompt: '' });
  });
}

async function gfetch(url, token, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  if (res.status === 401) {
    // トークン失効時は次回再取得させる
    Object.keys(tokens).forEach((k) => { if (tokens[k].token === token) delete tokens[k]; });
  }
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg += ' ' + ((await res.json()).error?.message || ''); } catch { /* 本文なし */ }
    throw new Error(`Google API エラー: ${msg}`);
  }
  return res;
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

export async function driveSave(token, data) {
  const content = JSON.stringify(data);
  const file = await findBackupFile(token);
  if (file) {
    const res = await gfetch(`https://www.googleapis.com/upload/drive/v3/files/${file.id}?uploadType=media&fields=id,modifiedTime`, token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: content,
    });
    return res.json();
  }
  const boundary = 'tcg' + Date.now();
  const meta = { name: BACKUP_FILE_NAME, mimeType: 'application/json' };
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`
    + `--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
  const res = await gfetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime', token, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return res.json();
}

export async function driveLoad(token) {
  const file = await findBackupFile(token);
  if (!file) return null;
  const res = await gfetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, token);
  return { data: await res.json(), modifiedTime: file.modifiedTime };
}
