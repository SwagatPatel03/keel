import fs from 'node:fs';
import path from 'node:path';
import { ProjectStore, resolveRoot, loadConfig, projectSettings } from './store.mjs';
import { Shadow } from './checkpoint.mjs';
import { verify, baselineProposal, approveBaseline, acceptanceProposal, approveAcceptance } from './verification.mjs';
import { taskContext, status, statusText } from './status.mjs';
import { auditStore, readJson, keyFor } from './workspace.mjs';
import { checkpointPatch, transact, sessionRevert, undoTransaction, transactionText } from './transactions.mjs';
import { renderClackStatus, cherryPickRevert } from './tui.mjs';
import { within } from './policy.mjs';

const flag = (args, name) => args.includes(name) ? args[args.indexOf(name) + 1] : null;
export function reliableCli(command, args) {
  if (command === 'revert' && (args.includes('-i') || args.includes('--interactive') || args.includes('--preview'))) return false;
  if (!['verify', 'status', 'baseline', 'acceptance', 'apply', 'audit', 'revert'].includes(command) && !(command === 'receipt' && args.includes('--json'))) return false;
  const store = new ProjectStore(resolveRoot(process.cwd(), process.env.CLAUDE_PROJECT_DIR));
  const context = taskContext(store), settings = projectSettings(loadConfig(), store.root);
  const json = args.includes('--json');
  try {
    if (command === 'verify') {
      const evidence = verify(store, { ...context, settings });
      process.stdout.write(json ? JSON.stringify(evidence, null, 2) + '\n' : statusText(status(store)));
      process.exitCode = evidence.verdict === 'verified' ? 0 : evidence.verdict === 'failed' ? 1 : 2;
    } else if (command === 'status' || command === 'receipt') {
      if (command === 'status' && args.includes('--pretty') && !json) {
        process.stdout.write(renderClackStatus(store));
      } else {
        const result = status(store);
        process.stdout.write(json ? JSON.stringify(result, null, 2) + '\n' : statusText(result));
      }
    } else if (command === 'baseline') {
      if (args[0] !== 'approve' || !flag(args, '--task')) throw new Error('Usage: keel baseline approve --task <id> [--accept <displayed-hash>]');
      const task = flag(args, '--task');
      const shadow = new Shadow(store).init(), checkpoint = shadow.snapshot(context.session, 'baseline-proposal');
      if (!checkpoint) throw new Error('Cannot capture baseline proposal.');
      const proposal = baselineProposal(store, task, checkpoint, settings);
      if (flag(args, '--accept')) { approveBaseline(store, proposal, flag(args, '--accept')); process.stdout.write('Baseline approved. Earlier acceptance evidence is stale; run keel verify.\n'); }
      else process.stdout.write(`${proposal.diff}\nChecks: ${JSON.stringify(proposal.checks)}\nCriteria: ${JSON.stringify(proposal.criteria)}\nApprove this exact change: keel baseline approve --task ${task} --accept ${proposal.approval}\n`);
    } else if (command === 'acceptance') {
      const task = flag(args, '--task'), criterion = flag(args, '--criterion');
      if (args[0] !== 'approve' || !task || !criterion) throw new Error('Usage: keel acceptance approve --task <id> --criterion <id> [--accept <displayed-hash>]');
      const shadow = new Shadow(store).init(), checkpoint = shadow.snapshot(context.session, 'acceptance-proposal');
      if (!checkpoint) throw new Error('Cannot capture manual acceptance snapshot.');
      const proposal = acceptanceProposal(store, task, criterion, checkpoint, settings);
      if (flag(args, '--accept')) { approveAcceptance(store, proposal, flag(args, '--accept')); process.stdout.write('Manual criterion recorded for this exact snapshot. Run keel verify for the complete verdict.\n'); }
      else process.stdout.write(`Manual review required: ${JSON.stringify(proposal.criterion)}\n${proposal.diff}\nAfter performing this review: keel acceptance approve --task ${task} --criterion ${criterion} --accept ${proposal.approval}\n`);
    } else if (command === 'audit') {
      const shadow = new Shadow(store).init();
      if (args.includes('--purge-quarantined')) {
        const audit = auditStore(shadow);
        if (!audit.quarantined) throw new Error('Store is not quarantined.');
        if (flag(args, '--confirm-project') !== store.id) throw new Error(`This deletes ALL checkpoint recovery history, including quarantined blobs. Re-run with --confirm-project ${store.id} after reviewing keel audit.`);
        if (!within(fs.realpathSync(store.dir), fs.realpathSync(store.shadowDir))) throw new Error('Checkpoint store resolves outside the project store; purge stopped.');
        fs.rmSync(store.shadowDir, { recursive: true, force: true });
        process.stdout.write('Checkpoint store purged. Session logs remain; old checkpoint references are unavailable.\n');
      } else { const result = auditStore(shadow); process.stdout.write(JSON.stringify(result, null, 2) + '\n'); }
    } else {
      const dryRun = args.includes('--dry-run');
      let result;
      if (command === 'revert') {
        const filesFlag = flag(args, '--files');
        if (args[0] === 'undo' || args[0] === 'redo') result = undoTransaction(store, { dryRun, direction: args[0] });
        else if (filesFlag) result = cherryPickRevert(store, flag(args, '--session') || context.session, { files: filesFlag.split(',').map((s) => s.trim()).filter(Boolean), dryRun });
        else result = sessionRevert(store, flag(args, '--session') || context.session, { dryRun });
      } else {
        const session = args[0];
        if (!session || session.startsWith('-')) throw new Error('Usage: keel apply <session> [--dry-run]');
        const sessionFile = path.join(store.dir, 'protected', keyFor(session), 'session.json');
        const record = readJson(sessionFile);
        if (!record?.base || !record?.candidate || record.state !== 'complete') throw new Error('No completed protected-session candidate.');
        result = transact(store, session, checkpointPatch(store, record.base, record.candidate), { dryRun });
      }
      process.stdout.write(json ? JSON.stringify(result, null, 2) + '\n' : transactionText(result));
      if (result.conflicts.length) process.exitCode = 1;
    }
  } catch (error) {
    process.stdout.write(json ? JSON.stringify({ verdict: 'not_verified', reasons: [error.message] }) + '\n' : `Keel could not finish: ${error.message}\n`);
    process.exitCode = 2;
  }
  return true;
}
