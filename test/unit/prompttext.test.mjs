import test from 'node:test';
import assert from 'node:assert/strict';
import { userText, isReply } from '../../src/prompttext.mjs';
import { sizeTask, clarityCheck } from '../../src/sizer.mjs';
import { isDebuggingPrompt } from '../../src/learn.mjs';

/** The block a browser extension added in front of a real question, as it arrived. */
export const BROWSER_BLOCK = `<browser_instruction># Claude in Chrome browser automation

You have access to browser automation tools (mcp__claude-in-chrome__*) for interacting with web pages in Chrome. Follow these guidelines for effective browser automation.

## Loading deferred tools

If the mcp__claude-in-chrome__* tools are deferred (must be loaded via ToolSearch before use), load every tool you expect to need in ONE ToolSearch call — the select query accepts a comma-separated list — never one call per tool. Start with the core set:

ToolSearch with query "select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__tabs_close_mcp"

Add task-specific tools to the same call when the task obviously needs them: read_console_messages / read_network_requests for debugging, form_input for forms, gif_creator for recordings, javascript_tool for page scripting.

## GIF recording

When performing multi-step browser interactions that the user may want to review or share, use mcp__claude-in-chrome__gif_creator to record them.

You must ALWAYS:
* Capture extra frames before and after taking actions to ensure smooth playback
* Name the file meaningfully to help the user identify it later (e.g., "login_process.gif")

## Console log debugging

You can use mcp__claude-in-chrome__read_console_messages to read console output. Console output may be verbose. If you are looking for specific log entries, use the 'pattern' parameter with a regex-compatible pattern. This filters results efficiently and avoids overwhelming output. For example, use pattern: "[MyApp]" to filter for application-specific logs rather than reading all console output.

## Alerts and dialogs

IMPORTANT: Do not trigger JavaScript alerts, confirms, prompts, or browser modal dialogs through your actions. These browser dialogs block all further browser events and will prevent the extension from receiving any subsequent commands. Instead, when possible, use console.log for debugging and then use the mcp__claude-in-chrome__read_console_messages tool to read those log messages. If a page has dialog-triggering elements:
1. Avoid clicking buttons or links that may trigger alerts (e.g., "Delete" buttons with confirmation dialogs)
2. If you must interact with such elements, warn the user first that this may interrupt the session
3. Use mcp__claude-in-chrome__javascript_tool to check for and dismiss any existing dialogs before proceeding

If you accidentally trigger a dialog and lose responsiveness, inform the user they need to manually dismiss it in the browser.

## Avoid rabbit holes and loops

When using browser automation tools, stay focused on the specific task. If you encounter any of the following, stop and ask the user for guidance:
- Unexpected complexity or tangential browser exploration
- Browser tool calls failing or returning errors after 2-3 attempts
- No response from the browser extension
- Page elements not responding to clicks or input
- Pages not loading or timing out
- Unable to complete the browser task despite multiple approaches

Explain what you attempted, what went wrong, and ask how the user would like to proceed. Do not keep retrying the same failing browser action or explore unrelated pages without checking in first.

## Tab context and session startup

IMPORTANT: At the start of each browser automation session, call mcp__claude-in-chrome__tabs_context_mcp first to get information about the user's current browser tabs. Use this context to understand what the user might want to work with before creating new tabs.

Never reuse tab IDs from a previous/other session. Follow these guidelines:
1. Only reuse an existing tab if the user explicitly asks to work with it
2. Otherwise, create a new tab with mcp__claude-in-chrome__tabs_create_mcp
3. If a tool returns an error indicating the tab doesn't exist or is invalid, call tabs_context_mcp to get fresh tab IDs
4. When a tab is closed by the user or a navigation error occurs, call tabs_context_mcp to see what tabs are available</browser_instruction>`;

export const QUESTION = 'Ok so added to market place and installed. Now how to use it? Do I have to do something or it will be used by itself?';

test('blocks an extension adds are left out, and the question alone is sized', () => {
  const full = `${BROWSER_BLOCK}${QUESTION}`;
  assert.equal(userText(full), QUESTION);
  assert.equal(sizeTask(full).size, 'feature', 'the whole text looked like a feature (this was the bug)');
  assert.notEqual(sizeTask(userText(full) || '').size, 'feature');
  assert.equal(isDebuggingPrompt(userText(full), sizeTask(userText(full) || '').size), false);
  assert.equal(userText('<system-reminder>be brief</system-reminder>\nFix src/cart.mjs, the total shows NaN'), 'Fix src/cart.mjs, the total shows NaN');
  assert.equal(userText('<ide_opened_file>The user opened src/a.js</ide_opened_file>Add a search bar to the products page'), 'Add a search bar to the products page');
  assert.equal(userText(`${BROWSER_BLOCK}`), '', 'nothing typed by the user');
  assert.equal(userText('Explain <b>bold</b> tags in HTML'), 'Explain <b>bold</b> tags in HTML', 'ordinary markup the user typed stays');
  assert.equal(userText(null), null);
});

test('short replies to the agent are not new requests; real requests are', () => {
  for (const reply of ['Yes', 'yes', 'OK', 'ok, go ahead', 'Yes please', 'No thanks', 'Sure, do it', 'go ahead', 'Continue', 'LGTM', 'Approved.',
    'Both', 'both.', 'Both please', 'Either one', 'Neither', 'The first one', 'the second option', 'Option B', 'B', '2', 'All of them']) {
    assert.equal(isReply(reply), true, reply);
  }
  for (const request of ['fix the login bug', 'Yes, and also fix src/cart.mjs', 'Add a search bar to the products page', 'No, the checkout page crashes when the cart is empty and the total is wrong', 'Okay.md',
    'the login page crashes', 'The first test fails with NaN in src/cart.mjs', 'Build both the API and the UI for the search page']) {
    assert.equal(isReply(request), false, request);
  }
  assert.equal(clarityCheck('Yes', sizeTask('Yes').size).ask, true, 'on its own, "Yes" looks vague (this was the bug)');
});
