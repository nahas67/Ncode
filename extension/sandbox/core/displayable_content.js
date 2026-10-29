export function hasDisplayableThoughts(thoughts) {
    return typeof thoughts === 'string' ? thoughts.trim().length > 0 : Boolean(thoughts);
}

export function hasDisplayableText(text) {
    return typeof text === 'string' ? text.trim().length > 0 : Boolean(text);
}
