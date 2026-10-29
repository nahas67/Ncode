import { formatT } from '../../../core/i18n.js';

export function setProviderModelListStatus(section, text, isError = false) {
    const { dedicatedApiModelListStatus, dedicatedApiRefreshModels } = section.elements;
    if (dedicatedApiRefreshModels) dedicatedApiRefreshModels.disabled = false;
    if (!dedicatedApiModelListStatus) return;
    dedicatedApiModelListStatus.textContent = text || '';
    dedicatedApiModelListStatus.hidden = !text;
    dedicatedApiModelListStatus.classList.toggle('is-error', isError);
}

export function setProviderModelList(section, provider, models) {
    const modelIds = (Array.isArray(models) ? models : [])
        .map((model) => String(model || '').trim())
        .filter(Boolean);
    if (!provider || modelIds.length === 0) return;

    const modelText = modelIds.join(', ');
    const previous = section.dedicatedApiProviders[provider] || { provider };
    section.dedicatedApiProviders[provider] = {
        ...previous,
        provider,
        model: modelText,
        selectedModel: modelIds.includes(previous.selectedModel) ? previous.selectedModel : '',
    };

    if (section.activeProvider === provider && section.elements.dedicatedApiModel) {
        section.elements.dedicatedApiModel.value = modelText;
    }
    section.setProviderModelListStatus(formatT('modelListUpdated', { count: modelIds.length }));
}
