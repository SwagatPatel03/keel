// Compatibility exports use selective transactions; whole-project reset is gone.
import { sessionRevert, undoTransaction, transactionText } from './transactions.mjs';
export function revert(store) { const session = store.listSessions()[0]; if (!session) return 'Keel has no checkpoints for this project yet.\n'; return transactionText(sessionRevert(store, session)); }
export function undoRevert(store) { return transactionText(undoTransaction(store)); }
