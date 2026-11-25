const mainAction = /^Which action\?(?: \(([2-9]|[1-9]\d+) remaining\))?$/;

export const isMainAction = prompt => typeof prompt === 'string' && mainAction.test(prompt);
export const policyPrompt = prompt => isMainAction(prompt) ? 'Which action?' : prompt;
