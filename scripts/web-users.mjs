import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { hashWebPassword } = require('../bin/web-auth.js');
const { readJsonObject, writeJsonAtomic } = require('../bin/util/json-storage.js');

const [command, username, ...options] = process.argv.slice(2);
const index = options.indexOf('--file');
const file = index >= 0 ? options[index + 1] : process.env.TAU_WEB_USERS_FILE;
if (!file || !['add', 'remove', 'list'].includes(command)) throw new Error('Usage: node scripts/web-users.mjs <add|remove|list> <username|-> --file <whitelist.json> [--password-stdin]');
const document = fs.existsSync(file) ? readJsonObject(file) : { schemaVersion: 1, users: {} };
const permissions = fs.existsSync(file) ? fs.statSync(file) : null;
if (document.schemaVersion !== 1 || !document.users || typeof document.users !== 'object' || Array.isArray(document.users)) throw new Error('Invalid account whitelist');
if (command === 'list') {
  console.log(Object.keys(document.users).sort().join('\n'));
} else {
  if (!/^[a-zA-Z0-9_.@-]{1,64}$/.test(username || '') || ['__proto__', 'constructor', 'prototype'].includes(username)) throw new Error('Invalid username');
  if (command === 'remove') {
    delete document.users[username];
  } else {
    let password = crypto.randomBytes(18).toString('base64url');
    if (options.includes('--password-stdin')) {
      let input = '';
      for await (const chunk of process.stdin) { input += chunk; if (input.length > 258) throw new Error('Password too long'); }
      password = input.replace(/\r?\n$/, '');
    }
    if (password.length < 10 || password.length > 256) throw new Error('Password must contain 10–256 characters');
    const salt = crypto.randomBytes(16).toString('hex');
    document.users[username] = { salt, passwordHash: (await hashWebPassword(password, salt)).toString('hex') };
    if (!options.includes('--password-stdin')) console.log(`Account: ${username}\nTemporary password: ${password}`);
  }
  writeJsonAtomic(file, document);
  if (permissions && require('../bin/host-platform.js').hostPlatform.posixPermissions) {
    fs.chownSync(file, permissions.uid, permissions.gid);
    fs.chmodSync(file, permissions.mode & 0o777);
  }
  console.log(`${command === 'remove' ? 'Removed' : 'Saved'} ${username}`);
}
