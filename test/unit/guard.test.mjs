// The destructive-command suite (Phase 3 exit criterion): commands that must
// be refused or questioned, and everyday commands that must pass untouched.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { checkToolCall, askMessage, refusalMessage } from '../../src/guard/index.mjs';
import { invocations } from '../../src/guard/shell.mjs';

const root = path.join(os.homedir(), 'projects', 'keel-guard-project');
const bash = (command, cfg = {}) => checkToolCall('Bash', { command }, { root, ...cfg }).decision;

const REFUSE = [
  'rm -rf /',
  'rm -rf ~',
  'rm -rf ~/',
  'rm -rf $HOME',
  'rm -fr /*',
  'rm -r -f /',
  'rm --recursive --force ~',
  'sudo rm -rf /',
  'sudo -u root rm -rf /usr',
  'bash -c "rm -rf ~"',
  'sh -c \'cd / && rm -rf *\' ; rm -rf /',
  'echo hi && rm -rf ~/',
  'eval "rm -rf /"',
  'env FOO=1 rm -rf ~',
  'powershell -Command "Remove-Item -Recurse -Force C:\\"',
  'pwsh -c "Remove-Item -Recurse -Force $env:USERPROFILE"',
  'Remove-Item -Recurse -Force C:\\',
  'Remove-Item C:\\Users -Recurse',
  'rd /s /q C:\\',
  'cmd /c "rmdir /s /q C:\\Windows"',
  'del /s /q C:\\*',
  'dd if=/dev/zero of=/dev/sda bs=1M',
  'mkfs.ext4 /dev/sdb1',
  'format D:',
  'diskpart',
  'Format-Volume -DriveLetter D',
  'chmod -R 777 /',
  'chown -R nobody /',
  'mv ~ /tmp/x',
  'find / -name "*.log" -delete',
  'find ~ -type f -exec rm {} \\;',
  ':(){ :|:& };:',
  'echo data > /dev/sda',
  'xargs rm -rf / < list.txt',
];

const ASK = [
  'git reset --hard',
  'git reset --hard HEAD~3',
  'git clean -fd',
  'git clean -fdx',
  'git push --force',
  'git push -f origin main',
  'git push origin +main',
  'git push origin --delete feature',
  'git branch -D old-feature',
  'git checkout -- .',
  'git checkout .',
  'git restore src/cart.js',
  'git stash clear',
  'git stash drop',
  'git filter-branch --tree-filter "rm secrets" HEAD',
  'git reflog expire --expire=now --all',
  'git gc --prune=now',
  'rm -rf src',
  'rm -rf .',
  'rm -rf ./*',
  'rm -rf ../other-project',
  'Remove-Item -Recurse -Force src',
  'del /s /q *',
  'find . -name "*.js" -delete',
  'psql -c "DROP TABLE users"',
  'psql mydb -c "TRUNCATE orders"',
  'mysql -e "DELETE FROM users"',
  'sqlite3 app.db "DROP TABLE sessions;"',
  'npx prisma migrate reset',
  'npx prisma db push --accept-data-loss',
  'rails db:drop',
  'python manage.py flush',
  'supabase db reset',
  'redis-cli FLUSHALL',
  'terraform destroy',
  'terraform apply -destroy',
  'kubectl delete ns staging',
  'kubectl delete pods --all',
  'aws s3 rm s3://bucket --recursive',
  'docker system prune -a --volumes',
  'docker volume rm db-data',
  'npm publish',
  'vercel --prod',
  'firebase deploy',
  'cat .env',
  'type .env.local',
  'Get-Content .env',
  'grep KEY .env.production',
  'cat ~/.ssh/id_rsa',
  'cat ~/.aws/credentials',
  'printenv',
  'env',
  'echo $OPENAI_API_KEY',
  'echo "SECRET=1" >> .env',
  'sed -i "s/a/b/" .github/workflows/ci.yml',
  'cp new.lock package-lock.json',
  'rm -rf $(echo /)',
];

const PASS = [
  'npm test',
  'npm run build',
  'npm install express',
  'node --test',
  'git status',
  'git diff',
  'git log --oneline -5',
  'git add -A && git commit -m "fix"',
  'git push',
  'git push origin feature --force-with-lease',
  'git checkout -b new-branch',
  'git checkout main',
  'git restore --staged src/cart.js',
  'git stash',
  'git branch -d merged-feature',
  'git clean -n',
  'rm -rf node_modules',
  'rm -rf dist build .next',
  'rm -rf coverage',
  'rm file.txt',
  'rm src/old.js',
  'rmdir empty-folder',
  'Remove-Item -Recurse -Force node_modules',
  'ls -la',
  'Get-ChildItem',
  'cat package.json',
  'cat .env.example',
  'Get-Content README.md',
  'mkdir -p src/utils',
  'touch src/new.js',
  'echo "hello" > notes.txt',
  'python -m pytest -q',
  'pytest tests/',
  'go test ./...',
  'cargo build',
  'docker ps',
  'docker build -t app .',
  'psql -c "SELECT * FROM users"',
  'mysql -e "DELETE FROM sessions WHERE expired = 1"',
  'npx prisma migrate dev',
  'terraform plan',
  'kubectl get pods',
  'find . -name "*.test.js"',
  'chmod +x scripts/run.sh',
  'echo $PATH',
  'grep -r "TODO" src',
  'curl https://example.com',
];

test('refuses catastrophic commands', () => {
  const missed = REFUSE.filter((c) => bash(c) !== 'refuse').map((c) => `${c} -> ${bash(c)}`);
  assert.deepEqual(missed, []);
});

test('asks before dangerous but sometimes-needed commands', () => {
  const missed = ASK.filter((c) => bash(c) !== 'ask').map((c) => `${c} -> ${bash(c)}`);
  assert.deepEqual(missed, []);
});

test('lets everyday commands through untouched', () => {
  const flagged = PASS.filter((c) => bash(c) !== 'allow').map((c) => `${c} -> ${bash(c)}: ${checkToolCall('Bash', { command: c }, { root }).findings.map((f) => f.rule).join(', ')}`);
  assert.deepEqual(flagged, []);
});

test('the suite is the size the plan promised', () => {
  assert.ok(REFUSE.length + ASK.length >= 80, `${REFUSE.length + ASK.length} guarded commands`);
  assert.ok(PASS.length >= 40, `${PASS.length} everyday commands`);
});

test('file tools: secret files ask on read and edit, git internals are refused, CI and lockfiles ask on edit', () => {
  const tool = (t, file) => checkToolCall(t, { file_path: path.join(root, file) }, { root }).decision;
  assert.equal(tool('Read', '.env'), 'ask');
  assert.equal(tool('Read', '.env.example'), 'allow');
  assert.equal(tool('Edit', 'config/.env.production'), 'ask');
  assert.equal(tool('Read', 'certs/server.key'), 'ask');
  assert.equal(tool('Edit', '.git/config'), 'refuse');
  assert.equal(tool('Read', '.git/config'), 'allow');
  assert.equal(tool('Edit', '.github/workflows/ci.yml'), 'ask');
  assert.equal(tool('Read', '.github/workflows/ci.yml'), 'allow');
  assert.equal(tool('Write', 'package-lock.json'), 'ask');
  assert.equal(tool('Edit', 'prisma/migrations/001_init/migration.sql'), 'ask');
  assert.equal(tool('Edit', 'src/cart.js'), 'allow');
  assert.equal(checkToolCall('Read', { file_path: path.join(os.homedir(), '.ssh', 'id_ed25519') }, { root }).decision, 'ask');
});

test('modes, allow patterns and custom protected paths', () => {
  assert.equal(bash('terraform destroy', { mode: 'standard' }), 'allow', 'infra pack is off in standard mode');
  assert.equal(bash('git reset --hard', { mode: 'standard' }), 'ask');
  assert.equal(bash('rm -rf /', { mode: 'off' }), 'allow');
  assert.equal(bash('npm publish', { allow: ['^npm publish$'] }), 'allow');
  assert.equal(checkToolCall('Edit', { file_path: path.join(root, 'infra', 'prod.tfvars') }, { root, protect: ['infra/*.tfvars'] }).decision, 'ask');
});

test('the parser unwraps, strips prefixes and normalises flags', () => {
  const inv = invocations('sudo env X=1 bash -c "cd app && rm -fr build/ || echo no"');
  assert.deepEqual(inv.map((i) => i.cmd), ['cd', 'rm', 'echo']);
  const rm = inv[1];
  assert.ok(rm.flags.has('r') && rm.flags.has('f'));
  assert.deepEqual(rm.positional, ['build/']);
  assert.deepEqual(invocations('Remove-Item -Recurse -Force -Path dist').map((i) => [...i.flags].sort()), [['force', 'path', 'recurse']]);
  assert.deepEqual([...invocations('rm -rfv x')[0].flags].sort(), ['f', 'r', 'v']);
  assert.deepEqual(invocations('echo a > out.txt 2>&1')[0].redirects, ['out.txt']);
});

test('messages explain in plain words, offer a safer way and mention the checkpoint', () => {
  const { findings } = checkToolCall('Bash', { command: 'git reset --hard' }, { root });
  assert.equal(askMessage(findings, true), 'Keel: git reset --hard throws away all uncommitted changes in tracked files. Safer: git stash keeps the changes so you can get them back. Keel saved a checkpoint first, so /keel:revert can bring back project files.');
  const refused = checkToolCall('Bash', { command: 'rm -rf ~' }, { root });
  assert.match(refusalMessage(refused.findings, 'refuse'), /^Keel refused this command: rm -r ~ would permanently delete your whole home folder\. This cannot be undone\./);
  assert.match(refusalMessage(refused.findings, 'refuse'), /ask them to run it themselves/);
});
