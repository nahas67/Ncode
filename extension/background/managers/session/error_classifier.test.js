import { describe, expect, it, vi } from 'vitest';
import {
    classifyProviderError,
    isRefreshableWebAuthError,
    isUnavailableWebAuthError,
    withProviderRetry,
} from './error_classifier.js';

describe('classifyProviderError', () => {
    it('classifies rate-limit (429) as retryable', () => {
        expect(classifyProviderError('API Error (429): Too Many Requests')).toEqual({
            kind: 'rate_limit',
            retryable: true,
        });
    });

    it('classifies "Too Many Requests" text without a status code', () => {
        expect(classifyProviderError('Too Many Requests')).toEqual({
            kind: 'rate_limit',
            retryable: true,
        });
    });

    it('classifies 5xx server errors as retryable', () => {
        expect(classifyProviderError('API Error (503): Service Unavailable')).toEqual({
            kind: 'server',
            retryable: true,
        });
    });

    it('classifies network-level errors as retryable', () => {
        const messages = [
            'fetch failed',
            'Network Error',
            'Failed to fetch',
            'ECONNRESET',
            'ETIMEDOUT',
            'Check network connection',
            'No valid response found',
        ];
        for (const message of messages) {
            expect(classifyProviderError(message)).toEqual({ kind: 'network', retryable: true });
        }
    });

    it('classifies refreshable auth (401/403) as retryable', () => {
        expect(classifyProviderError('API Error (401): Unauthorized')).toEqual({
            kind: 'auth',
            retryable: true,
        });
        expect(classifyProviderError('Missing Gemini Web upload tokens')).toEqual({
            kind: 'auth',
            retryable: true,
        });
    });

    it('classifies unavailable web auth (not logged in) as non-retryable', () => {
        expect(classifyProviderError('Not logged in')).toEqual({ kind: 'auth', retryable: false });
        expect(classifyProviderError('未登录')).toEqual({ kind: 'auth', retryable: false });
        expect(classifyProviderError('Sign in to continue')).toEqual({
            kind: 'auth',
            retryable: false,
        });
        expect(classifyProviderError('Missing Gemini Web auth token: atValue')).toEqual({
            kind: 'auth',
            retryable: false,
        });
        expect(
            classifyProviderError(
                'Gemini Web request tokens unavailable for account 0: atValue, blValue'
            )
        ).toEqual({ kind: 'auth', retryable: false });
    });

    it('classifies 4xx (non-auth) validation errors as non-retryable', () => {
        expect(classifyProviderError('API Error (400): Bad Request')).toEqual({
            kind: 'validation',
            retryable: false,
        });
        expect(classifyProviderError('API Error (404): Not Found')).toEqual({
            kind: 'validation',
            retryable: false,
        });
    });

    it('falls back to unknown / non-retryable for unrecognised errors', () => {
        expect(classifyProviderError('Something unexpected happened')).toEqual({
            kind: 'unknown',
            retryable: false,
        });
    });

    it('accepts Error objects and empty input', () => {
        expect(classifyProviderError(new Error('API Error (429): rate'))).toEqual({
            kind: 'rate_limit',
            retryable: true,
        });
        expect(classifyProviderError('')).toEqual({ kind: 'unknown', retryable: false });
        expect(classifyProviderError(undefined)).toEqual({ kind: 'unknown', retryable: false });
    });
});

describe('shared auth classifiers', () => {
    it('isUnavailableWebAuthError detects login-required patterns', () => {
        expect(isUnavailableWebAuthError('Not logged in')).toBe(true);
        expect(isUnavailableWebAuthError('Missing Gemini Web auth token: blValue')).toBe(true);
        expect(isUnavailableWebAuthError('Missing Gemini Web auth token: atValue')).toBe(true);
        expect(isUnavailableWebAuthError('Missing Gemini Web auth token: fSid')).toBe(true);
        expect(
            isUnavailableWebAuthError('Gemini Web request tokens unavailable for account 1: fSid')
        ).toBe(true);
        expect(isUnavailableWebAuthError('all good')).toBe(false);
    });

    it('isRefreshableWebAuthError detects token-refresh patterns', () => {
        expect(isRefreshableWebAuthError('401 Unauthorized')).toBe(true);
        expect(isRefreshableWebAuthError('Missing Gemini Web upload tokens')).toBe(true);
        expect(isRefreshableWebAuthError('not logged in')).toBe(false);
    });
});

describe('withProviderRetry', () => {
    it('returns the value on first success without retry', async () => {
        const fn = vi.fn().mockResolvedValue('ok');
        await expect(withProviderRetry(fn)).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on retryable errors up to maxAttempts', async () => {
        const fn = vi
            .fn()
            .mockRejectedValueOnce(new Error('API Error (429): rate limit'))
            .mockResolvedValueOnce('recovered');

        await expect(withProviderRetry(fn)).resolves.toBe('recovered');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('does not retry on non-retryable errors', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('API Error (400): Bad Request'));
        await expect(withProviderRetry(fn)).rejects.toThrow('API Error (400): Bad Request');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('rethrows AbortError immediately without retry', async () => {
        const abortError = new Error('cancelled');
        abortError.name = 'AbortError';
        const fn = vi.fn().mockRejectedValue(abortError);
        await expect(withProviderRetry(fn)).rejects.toThrow('cancelled');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('gives up after maxAttempts retries and rethrows the last error', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('fetch failed'));
        await expect(withProviderRetry(fn, { maxAttempts: 2 })).rejects.toThrow('fetch failed');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry 401/403 auth errors by default (static-key providers)', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('API Error (401): Unauthorized'));
        await expect(withProviderRetry(fn)).rejects.toThrow('API Error (401): Unauthorized');
        expect(fn).toHaveBeenCalledTimes(1);

        const fn403 = vi.fn().mockRejectedValue(new Error('API Error (403): Forbidden'));
        await expect(withProviderRetry(fn403)).rejects.toThrow('API Error (403): Forbidden');
        expect(fn403).toHaveBeenCalledTimes(1);
    });

    it('retries 401/403 auth errors when canRefreshAuth is true (Web provider)', async () => {
        const fn = vi
            .fn()
            .mockRejectedValueOnce(new Error('API Error (401): Unauthorized'))
            .mockResolvedValueOnce('recovered');

        await expect(withProviderRetry(fn, { canRefreshAuth: true })).resolves.toBe('recovered');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('still retries transient (non-auth) errors regardless of canRefreshAuth', async () => {
        const fn = vi
            .fn()
            .mockRejectedValueOnce(new Error('API Error (503): Service Unavailable'))
            .mockResolvedValueOnce('recovered');

        await expect(withProviderRetry(fn)).resolves.toBe('recovered');
        expect(fn).toHaveBeenCalledTimes(2);
    });
});
