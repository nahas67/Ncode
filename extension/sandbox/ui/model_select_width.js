export function resizeSelectToSelectedOption(select, extraWidth = 34) {
    if (!select) return false;

    if (select.selectedIndex === -1) {
        if (select.options.length > 0) {
            select.selectedIndex = 0;
        } else {
            return false;
        }
    }

    const selectedOption = select.options[select.selectedIndex];
    if (!selectedOption) return false;

    const tempSpan = document.createElement('span');
    Object.assign(tempSpan.style, {
        visibility: 'hidden',
        position: 'absolute',
        fontSize: '13px',
        fontWeight: '500',
        fontFamily: window.getComputedStyle(select).fontFamily,
        whiteSpace: 'nowrap',
    });
    tempSpan.textContent = selectedOption.text;
    document.body.appendChild(tempSpan);
    const width = tempSpan.getBoundingClientRect().width;
    document.body.removeChild(tempSpan);
    select.style.width = `${width + extraWidth}px`;
    return true;
}
