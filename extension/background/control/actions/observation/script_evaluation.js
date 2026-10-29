import { BaseActionHandler } from '../base.js';

const MAX_SCRIPT_LENGTH = 10240;
const EVALUATION_TIMEOUT_MS = 10000;

function withEvaluationTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`Script evaluation timed out after ${ms}ms`)),
            ms
        );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createFunctionDeclaration(script) {
    let functionDeclaration = script.trim();

    const isFunction =
        /^(async\s+)?function\b/.test(functionDeclaration) ||
        /^\(?[\w\s,]*\)?\s*=>/.test(functionDeclaration);

    if (isFunction) return functionDeclaration;

    if (/\breturn\b/.test(functionDeclaration)) {
        return `async function() { ${functionDeclaration} }`;
    }

    return `async function() { return (${functionDeclaration}); }`;
}

function createEvaluateExpression(functionDeclaration, args) {
    return `(async () => {
        const __geminiNexusFn = ${functionDeclaration};
        const __geminiNexusArgs = ${JSON.stringify(args)};
        return await __geminiNexusFn.apply(null, __geminiNexusArgs);
    })()`;
}

function formatEvaluationResponse(response) {
    if (response.exceptionDetails) {
        const exception = response.exceptionDetails;
        return `Script Exception: ${exception.text} ${exception.exception ? exception.exception.description : ''}`;
    }

    if (response.result) {
        if (response.result.type === 'undefined') return 'undefined';

        const value = response.result.value;
        if (typeof value === 'object' && value !== null) {
            return JSON.stringify(value, null, 2);
        }
        return String(value);
    }

    return 'undefined';
}

export class ScriptEvaluationActions extends BaseActionHandler {
    /**
     * Evaluates a script in the browser context.
     * Supports passing arguments (including DOM elements via UIDs).
     */
    async evaluateScript({ script, args = [] }) {
        try {
            if (typeof script !== 'string' || !script.trim()) {
                return "Error: 'script' must be a non-empty string.";
            }

            if (script.length > MAX_SCRIPT_LENGTH) {
                return `Error: Script exceeds the ${MAX_SCRIPT_LENGTH}-character safety limit (${script.length} chars).`;
            }

            const callArguments = [];
            const primitiveArguments = [];
            let targetObjectId = null;

            // Resolve UID arguments to CDP object IDs.
            if (args && Array.isArray(args)) {
                for (const arg of args) {
                    if (typeof arg === 'object' && arg !== null && arg.uid) {
                        try {
                            const objectId = await this.getObjectIdFromUid(arg.uid);
                            callArguments.push({ objectId });
                            primitiveArguments.push(null);
                            if (!targetObjectId) targetObjectId = objectId;
                        } catch (error) {
                            return `Error: Could not resolve argument with uid ${arg.uid}: ${error.message}`;
                        }
                    } else {
                        callArguments.push({ value: arg });
                        primitiveArguments.push(arg);
                    }
                }
            }

            const functionDeclaration = createFunctionDeclaration(script);

            if (targetObjectId) {
                const response = await withEvaluationTimeout(
                    this.cmd('Runtime.callFunctionOn', {
                        objectId: targetObjectId,
                        functionDeclaration,
                        arguments: callArguments,
                        returnByValue: true,
                        awaitPromise: true,
                        userGesture: true,
                    }),
                    EVALUATION_TIMEOUT_MS
                );
                return formatEvaluationResponse(response);
            }

            const response = await withEvaluationTimeout(
                this.cmd('Runtime.evaluate', {
                    expression: createEvaluateExpression(functionDeclaration, primitiveArguments),
                    returnByValue: true,
                    awaitPromise: true,
                    userGesture: true,
                }),
                EVALUATION_TIMEOUT_MS
            );
            return formatEvaluationResponse(response);
        } catch (error) {
            return `Error evaluating script: ${error.message}`;
        }
    }
}
