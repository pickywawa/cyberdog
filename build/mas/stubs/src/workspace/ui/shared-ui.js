// Mac App Store edition: groups, quick actions and paths are always stored on this Mac.
function sharedLocationField() { return null }
function sharedScopeName() { return '' }
function sharedVisible(entry) { return !entry.teamId }
function showServerHistory() {}
async function beforeActionRun() { return true }
function actionPayload(action) { return action.script }
