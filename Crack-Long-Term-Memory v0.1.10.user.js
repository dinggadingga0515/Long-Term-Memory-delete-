// ==UserScript==
// @name         Crack 장기기억 일괄관리
// @namespace    https://crack.wrtn.ai/
// @version      0.1.10
// @homepageURL  https://github.com/dinggadingga0515/Long-Term-Memory-delete-
// @supportURL   https://github.com/dinggadingga0515/Long-Term-Memory-delete-/issues
// @updateURL    https://raw.githubusercontent.com/dinggadingga0515/Long-Term-Memory-delete-/main/Crack-Long-Term-Memory.user.js
// @downloadURL  https://raw.githubusercontent.com/dinggadingga0515/Long-Term-Memory-delete-/main/Crack-Long-Term-Memory.user.js
// @description  Crack 장기기억 백업은 가능하지만 복구불가능함. Crack에서 해당기능 만들어주기 전까진 복구 안되니까 진짜 장기기억 지워버릴사람만 쓰셈. 책임 못짐.
// @author       딩가딩가
// @match        https://crack.wrtn.ai/*
// @run-at       document-idle
// @sandbox      DOM
// @inject-into  content
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// ==/UserScript==

(function () {
    'use strict';

    const API_BASE = 'https://crack-api.wrtn.ai/crack-gen/v3/chats';
    const CHUNK_SIZE = 5000;
    // TEMP: 장기기억 GET의 실제 허용 page limit을 실서버에서 확인한 뒤 고정값으로 교체한다.
    const READ_LIMIT_START = 1000;
    const READ_LIMIT_MIN = 20;
    const READ_LOG_RUNS = [];
    let READ_LOG_SEQUENCE = 0;
    // TEMP: 실제 Crack 서버의 안전한 DELETE 동시성 한계를 확인한 뒤 고정값으로 교체한다.
    const DELETE_CONCURRENCY_LEVELS = [50, 30, 20, 10, 5, 4];

    function getSummaryId(item) {
        return item && (item.id || item._id || item.summaryId || item.summary_id);
    }

    function isUserAddedSummary(item) {
        return !!item && (String(item.createdBy || '').toLowerCase() === 'user' || String(item.badge || '').trim() === '추가');
    }

    function chunkItems(items, chunkSize) {
        const size = chunkSize || CHUNK_SIZE;
        const out = [];
        for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
        return out;
    }

    function matchesGroup(item, group) {
        return group === 'user' ? isUserAddedSummary(item) : !isUserAddedSummary(item);
    }

    function toggleGroupSelection(cards, selectedIds, group, checked) {
        const next = new Set(selectedIds || []);
        for (const card of cards || []) {
            if (!matchesGroup(card, group)) continue;
            const id = String(getSummaryId(card) || '');
            if (!id) continue;
            if (checked) next.add(id);
            else next.delete(id);
        }
        return next;
    }

    function getGroupSelectionState(cards, selectedIds, group) {
        const ids = (cards || []).filter(card => matchesGroup(card, group)).map(card => String(getSummaryId(card) || '')).filter(Boolean);
        const selected = ids.filter(id => selectedIds && selectedIds.has(id)).length;
        return { checked: ids.length > 0 && selected === ids.length, indeterminate: selected > 0 && selected < ids.length, selected, total: ids.length };
    }


    function makeProgressEvent(phase, current, total, extra) {
        const hasTotal = Number.isFinite(total) && total >= 0;
        const safeCurrent = Number.isFinite(current) ? current : 0;
        const safeTotal = hasTotal ? total : null;
        const percent = safeTotal == null ? null : (safeTotal === 0 ? 100 : Math.min(100, safeCurrent / safeTotal * 100));
        return {
            phase,
            current: safeCurrent,
            total: safeTotal,
            remaining: safeTotal == null ? null : Math.max(0, safeTotal - safeCurrent),
            percent,
            ...(extra || {})
        };
    }

    function formatProgressText(event) {
        const value = event || {};
        const labels = { read:'서버 읽기', zip:'ZIP 묶기', patch:'수정', add:'추가', delete:'삭제', apply:'전체 교체', restore:'백업 복구', 'import-read':'파일 읽기', 'import-unpack':'ZIP 열기', 'import-parse':'JSON 파싱', 'import-validate':'카드 검증' };
        const operations = { patch:'수정', add:'추가', delete:'삭제' };
        const restoreLabel = value.phase === 'restore' ? (value.operation === 'user' ? '사용자 추가 복구' : value.operation === 'native' ? 'native 복구' : '백업 복구') : null;
        const label = restoreLabel || labels[value.phase] || String(value.phase || '진행');
        const operation = value.phase === 'apply' && operations[value.operation] ? ' · ' + operations[value.operation] : '';
        const concurrency = Number.isFinite(value.concurrency) ? ` · 동시 ${value.concurrency}` : '';
        const percent = Number.isFinite(value.percent) ? value.percent.toFixed(1) + '%' : '';
        if (value.phase === 'read-limit') return `서버 읽기 limit 조정 · ${Number(value.fromLimit || 0).toLocaleString()} → ${Number(value.toLimit || 0).toLocaleString()}`;
        if (value.phase === 'zip') return label + (percent ? ' · ' + percent : '');
        if (!Number.isFinite(value.total)) return `${label}${concurrency} · ${Number(value.current || 0).toLocaleString()}개 읽음 · 전체 수 확인 중`;
        const mark = value.estimated ? '약 ' : '';
        return `${label}${operation}${concurrency} · ${Number(value.current || 0).toLocaleString()} / ${mark}${Number(value.total || 0).toLocaleString()}${percent ? ' · ' + percent : ''} · ${mark}${Number(value.remaining || 0).toLocaleString()}개 남음`;
    }

    function getChatId() {
        if (typeof location === 'undefined') return null;
        const patterns = [/\/episodes\/([a-f0-9-]+)/i, /\/chats\/([a-f0-9-]+)/i, /\/c\/([a-f0-9-]+)/i];
        for (const pattern of patterns) {
            const match = location.pathname.match(pattern);
            if (match) return match[1];
        }
        return null;
    }

    function chatIdsMatch(a, b) {
        return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
    }

    function getToken() {
        if (typeof document === 'undefined') return null;
        const match = document.cookie.match(/(^| )access_token=([^;]+)/);
        return match ? match[2] : null;
    }

    function parseRetryAfterMs(value, now) {
        const raw = String(value == null ? '' : value).trim();
        if (!raw) return null;
        const seconds = Number(raw);
        if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
        const time = Date.parse(raw);
        if (!Number.isFinite(time)) return null;
        return Math.max(0, time - (Number.isFinite(now) ? now : Date.now()));
    }

    async function apiCall(method, path, body, options) {
        const opts = options || {};
        const token = getToken();
        const chatId = String(opts.chatId || getChatId() || '');
        if (!token || !chatId) throw new Error('인증 정보 또는 채팅 ID를 찾을 수 없습니다.');
        const response = await fetch(API_BASE + '/' + encodeURIComponent(chatId) + path, {
            method,
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: body == null ? undefined : JSON.stringify(body)
        });
        const text = await response.text();
        if (!response.ok) {
            const error = new Error('Crack API ' + response.status + ': ' + (text || '요청 실패'));
            error.status = response.status;
            const retryAfterMs = parseRetryAfterMs(response.headers && typeof response.headers.get === 'function' ? response.headers.get('Retry-After') : null);
            if (retryAfterMs != null) error.retryAfterMs = retryAfterMs;
            throw error;
        }
        if (!text) return { result: 'SUCCESS' };
        try { return JSON.parse(text); }
        catch (_) { throw new Error('Crack API 응답 JSON을 읽지 못했습니다.'); }
    }

    function assertMutationResponse(response) {
        if (!response || response.success === false || /^(?:FAIL|FAILED|FAILURE|ERROR)$/i.test(String(response.result || ''))) {
            throw new Error('서버가 장기기억 변경을 확인하지 않았습니다.');
        }
    }

    function declaredMemoryTotal(data) {
        const candidates = [
            data && data.totalCount,
            data && data.pagination && data.pagination.total,
            data && data.pageInfo && data.pageInfo.total
        ];
        for (const value of candidates) {
            const n = value == null || value === '' ? NaN : Number(value);
            if (Number.isFinite(n) && n >= 0) return n;
        }
        return null;
    }

    function nextReadLimit(limit) {
        if (limit <= READ_LIMIT_MIN) return null;
        return Math.max(READ_LIMIT_MIN, Math.floor(limit / 2));
    }

    function cloneReadLog(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function getReadLogRuns() {
        return cloneReadLog(READ_LOG_RUNS);
    }

    function clearReadLogRuns() {
        READ_LOG_RUNS.length = 0;
        READ_LOG_SEQUENCE = 0;
    }

    function formatReadDurationMs(ms) {
        const value = Number(ms || 0);
        return `${(value / 1000).toFixed(3)}초 (${value.toFixed(1)}ms)`;
    }

    function buildReadLogText(runs) {
        const list = Array.isArray(runs) ? runs : [];
        const requestCount = list.reduce((sum, run) => sum + (run.requests || []).length, 0);
        const totalElapsedMs = list.reduce((sum, run) => sum + Number(run.totalElapsedMs || 0), 0);
        const lines = [
            'Crack 장기기억 조회 성능 로그',
            `생성 시각: ${new Date().toISOString()}`,
            `조회 실행 수: ${list.length}`,
            `총 GET 요청 수: ${requestCount}`,
            `세션 누적 조회 실행 시간: ${formatReadDurationMs(totalElapsedMs)}`,
            ''
        ];
        for (const run of list) {
            lines.push(`=== 조회 #${run.runId} ===`);
            lines.push(`채팅 ID: ${run.chatId || '(알 수 없음)'}`);
            lines.push(`조회 목적: ${run.purpose || '장기기억 전체조회'}`);
            lines.push(`시작: ${run.startedAt || ''}`);
            lines.push(`종료: ${run.endedAt || ''}`);
            lines.push(`상태: ${run.status || 'UNKNOWN'}`);
            lines.push(`총 소요: ${formatReadDurationMs(run.totalElapsedMs)}`);
            lines.push(`총 GET 요청: ${(run.requests || []).length}`);
            lines.push(`시도 limit: ${(run.attemptedLimits || []).join(' → ') || '-'}`);
            lines.push(`성공 limit: ${run.successLimit == null ? '-' : Number(run.successLimit).toLocaleString()}`);
            lines.push(`최대 응답: ${run.maxPageSize == null ? '-' : Number(run.maxPageSize).toLocaleString()}`);
            lines.push(`최종 카드 수: ${run.totalCards == null ? '-' : Number(run.totalCards).toLocaleString()}`);
            if (run.error) lines.push(`최종 오류: ${run.error}`);
            if ((run.fallbacks || []).length) {
                lines.push('limit 하향:');
                for (const item of run.fallbacks) {
                    lines.push(`- ${Number(item.fromLimit).toLocaleString()} → ${Number(item.toLimit).toLocaleString()} | 요청 #${item.requestNo} | ${item.error || ''}`);
                }
            }
            lines.push('요청별 기록:');
            for (const item of run.requests || []) {
                const http = item.httpStatus == null ? '' : ` HTTP=${item.httpStatus}`;
                const returned = item.returned == null ? '-' : Number(item.returned).toLocaleString();
                const accumulated = item.accumulated == null ? '-' : Number(item.accumulated).toLocaleString();
                lines.push(`- 요청 #${item.requestNo} | 페이지 ${item.pageNo} | limit=${item.limit} | cursor=${item.cursor || '초기'} | 상태=${item.status}${http} | 반환=${returned} | 누적=${accumulated} | 소요=${formatReadDurationMs(item.elapsedMs)}${item.error ? ` | 오류=${item.error}` : ''}`);
            }
            lines.push('');
        }
        return lines.join('\n');
    }

    async function fetchAllLongTermMemories(options) {
        const opts = options || {};
        const request = opts.request || (path => apiCall('GET', path, null, opts));
        const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
        const expectedTotal = Number.isFinite(opts.expectedTotal) && opts.expectedTotal >= 0 ? opts.expectedTotal : null;
        const now = typeof opts.now === 'function' ? opts.now : () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());
        const wallNow = typeof opts.wallNow === 'function' ? opts.wallNow : () => Date.now();
        const runStart = now();
        const run = {
            runId: ++READ_LOG_SEQUENCE,
            chatId: String(opts.chatId || getChatId() || ''),
            purpose: String(opts.purpose || '장기기억 전체조회'),
            startedAt: new Date(wallNow()).toISOString(),
            endedAt: '',
            status: 'RUNNING',
            attemptedLimits: [],
            fallbacks: [],
            requests: [],
            successLimit: null,
            maxPageSize: null,
            totalCards: null,
            totalElapsedMs: 0,
            error: ''
        };
        READ_LOG_RUNS.push(run);
        let requestNo = 0;
        let pageLimit = READ_LIMIT_START;

        function finishRun(status, extra) {
            run.status = status;
            run.endedAt = new Date(wallNow()).toISOString();
            run.totalElapsedMs = Math.max(0, now() - runStart);
            if (extra) Object.assign(run, extra);
        }

        try {
            while (true) {
                run.attemptedLimits.push(pageLimit);
                const cards = [];
                const seenIds = new Set();
                const seenCursors = new Set();
                let cursor = '';
                let meta = null;
                let knownTotal = null;
                let maxPageSize = 0;
                let requestFailure = null;
                let pageNo = 0;

                while (true) {
                    let path = `/summaries?limit=${pageLimit}&type=longTerm&orderBy=newest&filter=all`;
                    if (cursor) path += '&cursor=' + encodeURIComponent(cursor);
                    const cursorLabel = cursor ? '계속' : '초기';
                    const currentRequestNo = ++requestNo;
                    const currentPageNo = ++pageNo;
                    const requestStart = now();
                    let response;
                    try { response = await request(path); }
                    catch (error) {
                        const requestError = error instanceof Error ? error : new Error(String(error || '장기기억 조회 요청 실패'));
                        run.requests.push({
                            requestNo: currentRequestNo,
                            pageNo: currentPageNo,
                            limit: pageLimit,
                            cursor: cursorLabel,
                            status: 'ERROR',
                            httpStatus: Number.isFinite(Number(requestError.status)) ? Number(requestError.status) : null,
                            returned: null,
                            accumulated: cards.length,
                            elapsedMs: Math.max(0, now() - requestStart),
                            error: requestError.message
                        });
                        requestFailure = requestError;
                        if ([401, 403].includes(Number(requestFailure.status))) throw requestFailure;
                        break;
                    }
                    const requestElapsedMs = Math.max(0, now() - requestStart);
                    const data = response && response.data;
                    if (!data || !Array.isArray(data.summaries)) {
                        run.requests.push({ requestNo: currentRequestNo, pageNo: currentPageNo, limit: pageLimit, cursor: cursorLabel, status: 'INVALID_RESPONSE', httpStatus: null, returned: null, accumulated: cards.length, elapsedMs: requestElapsedMs, error: '장기기억 목록 응답 형식이 올바르지 않습니다.' });
                        throw new Error('장기기억 목록 응답 형식이 올바르지 않습니다.');
                    }
                    const pageDeclaredTotal = declaredMemoryTotal(data);
                    run.requests.push({
                        requestNo: currentRequestNo,
                        pageNo: currentPageNo,
                        limit: pageLimit,
                        cursor: cursorLabel,
                        status: 'OK',
                        httpStatus: null,
                        returned: data.summaries.length,
                        accumulated: cards.length + data.summaries.length,
                        elapsedMs: requestElapsedMs,
                        declaredTotal: pageDeclaredTotal,
                        hasNext: !!data.nextCursor || data.hasNext === true
                    });
                    maxPageSize = Math.max(maxPageSize, data.summaries.length);
                    if (!meta) meta = data;
                    if (pageDeclaredTotal != null) knownTotal = pageDeclaredTotal;
                    if (!data.summaries.length) {
                        if (data.nextCursor || data.hasNext === true) throw new Error('장기기억 페이지 응답이 불완전합니다.');
                        break;
                    }
                    for (const item of data.summaries) {
                        const id = String(getSummaryId(item) || '').toLowerCase();
                        if (!id) throw new Error('장기기억 목록에 ID가 없는 카드가 있어 안전한 전체 조회를 확인할 수 없습니다.');
                        if (seenIds.has(id)) throw new Error('장기기억 목록에 중복 ID가 있습니다: ' + id);
                        seenIds.add(id);
                        cards.push(item);
                    }
                    const useEstimate = knownTotal == null && expectedTotal != null && cards.length <= expectedTotal;
                    const progressTotal = knownTotal != null ? knownTotal : (useEstimate ? expectedTotal : null);
                    onProgress(makeProgressEvent('read', cards.length, progressTotal, { estimated: useEstimate, pageLimit }));
                    if (!data.nextCursor) {
                        if (data.hasNext === true) throw new Error('장기기억 페이지 응답이 불완전합니다.');
                        if (knownTotal != null && knownTotal !== cards.length) {
                            throw new Error(`장기기억 전체 개수(${knownTotal})와 실제 조회 개수(${cards.length})가 달라 완전 조회를 확인할 수 없습니다.`);
                        }
                        if (knownTotal == null && cards.length > 0 && cards.length % CHUNK_SIZE === 0) {
                            throw new Error(`${cards.length}개 경계에서 continuation 정보 없이 조회가 끝났습니다. 사이트의 ${CHUNK_SIZE}개 조회 상한 가능성이 있어 전체 백업으로 확정할 수 없습니다.`);
                        }
                        break;
                    }
                    const next = String(data.nextCursor);
                    if (seenCursors.has(next)) throw new Error('장기기억 페이지 커서가 반복되었습니다.');
                    seenCursors.add(next);
                    cursor = next;
                }

                if (!requestFailure) {
                    finishRun('SUCCESS', { successLimit: pageLimit, maxPageSize, totalCards: cards.length });
                    return { cards, meta: meta || {}, readLimit: pageLimit, maxPageSize, readLog: cloneReadLog(run) };
                }

                const lower = nextReadLimit(pageLimit);
                if (lower == null) {
                    requestFailure.message += ` (조회 limit 시도: ${run.attemptedLimits.join(' → ')})`;
                    throw requestFailure;
                }
                run.fallbacks.push({ fromLimit: pageLimit, toLimit: lower, requestNo, error: requestFailure.message, httpStatus: Number.isFinite(Number(requestFailure.status)) ? Number(requestFailure.status) : null });
                onProgress(makeProgressEvent('read-limit', 0, null, { fromLimit: pageLimit, toLimit: lower, error: requestFailure.message }));
                pageLimit = lower;
            }
        } catch (error) {
            finishRun('FAILED', { error: String(error && error.message || error) });
            throw error;
        }
    }

    async function updateMemoryCard(item, card, options) {
        const id = getSummaryId(item);
        if (!id) throw new Error('장기기억 ID를 찾을 수 없습니다.');
        const response = await apiCall('PATCH', '/summaries/' + encodeURIComponent(id), { title: card.title, summary: card.summary }, options);
        assertMutationResponse(response);
    }

    async function addMemoryCard(card, options) {
        const response = await apiCall('POST', '/summaries', { type: 'longTerm', title: card.title, summary: card.summary }, options);
        assertMutationResponse(response);
    }

    async function addNativeMemoryCard(card, options) {
        const response = await apiCall('POST', '/summaries', { type: 'shortTerm', title: card.title, summary: card.summary }, options);
        assertMutationResponse(response);
    }

    async function deleteMemoryCard(item, options) {
        const id = getSummaryId(item);
        if (!id) throw new Error('장기기억 ID를 찾을 수 없습니다.');
        const response = await apiCall('DELETE', '/summaries/' + encodeURIComponent(id), null, options);
        assertMutationResponse(response);
    }

    function snapshotCards(cards) {
        return JSON.stringify((cards || []).map(item => [
            String(getSummaryId(item) || ''), cardSignature(item), String(item.createdBy || ''), String(item.badge || ''), String(item.createdAt || ''), String(item.updatedAt || '')
        ]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    }

    function cardSignature(item) {
        return JSON.stringify([String(item && item.title || '').trim(), String(item && item.summary || '').trim()]);
    }

    function orderCardsOldest(items, newestFirstFallback) {
        const rows = (items || []).slice();
        const dated = rows.map((item, index) => ({
            item, index, time: Date.parse(item && (item.createdAt || item.updatedAt) || '')
        }));
        if (dated.length && dated.every(row => Number.isFinite(row.time))) {
            dated.sort((a, b) => a.time - b.time || a.index - b.index);
            return dated.map(row => row.item);
        }
        return newestFirstFallback ? rows.reverse() : rows;
    }

    function resolveUserCount(meta, cards) {
        const raw = meta && meta.userCreatedCount;
        const parsed = raw == null || raw === '' ? NaN : Number(raw);
        return Number.isFinite(parsed) ? parsed : (cards || []).filter(isUserAddedSummary).length;
    }

    function invalidateImportData(state) {
        state.importedCards = null;
        state.importRejected = [];
        state.importPlan = null;
        if ('importMode' in state) state.importMode = null;
        if ('archiveMeta' in state) state.archiveMeta = null;
    }

    function selectFreshCardsByIds(cards, selectedIds) {
        const ids = new Set(selectedIds || []);
        const selected = (cards || []).filter(card => ids.has(String(getSummaryId(card) || '')));
        if (selected.length !== ids.size) throw new Error('선택한 카드 일부가 서버에서 사라졌거나 변경되었습니다. 새로고침 후 다시 선택해주세요.');
        return selected;
    }

    async function resolveExportSource(scope, currentCards, selectedIds, fetchFresh) {
        if (scope === 'all') return { cards: currentCards, fresh: null };
        const fresh = await fetchFresh();
        return { cards: selectFreshCardsByIds(fresh.cards, selectedIds), fresh };
    }

    function parseMemoryText(text) {
        const normalized = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
        if (!normalized) throw new Error('가져올 카드가 없습니다.');
        const lines = normalized.split('\n').filter(line => line.trim());
        if (!lines.length || !lines.every(line => line.trim().startsWith('{'))) {
            throw new Error('TXT는 v0.1.1부터 한 줄에 카드 1개인 JSONL 형식만 지원합니다. 구형 [제목] 형식은 본문과 카드 경계가 충돌할 수 있어 지원하지 않습니다.');
        }
        try {
            return lines.map(line => {
                const item = JSON.parse(line);
                return { ...item, title: String(item && item.title || '').trim(), summary: String(item && item.summary || '').trim() };
            });
        } catch (error) {
            throw new Error('TXT(JSONL) 형식이 올바르지 않습니다: ' + error.message);
        }
    }

    function normalizeArchiveJson(raw) {
        let rows = null;
        let newestFirst = false;
        if (Array.isArray(raw)) { rows = raw; newestFirst = true; }
        else if (raw && Array.isArray(raw.cards)) { rows = raw.cards; newestFirst = raw.order === 'newest-first'; }
        else if (raw && Array.isArray(raw.longTerm)) { rows = raw.longTerm; newestFirst = true; }
        else if (raw && Array.isArray(raw.summaries)) { rows = raw.summaries; }
        if (!Array.isArray(rows)) throw new Error('지원하는 카드 배열을 찾지 못했습니다.');
        const cloned = rows.map(item => ({
            ...(item || {}),
            title: String(item && item.title || '').trim(),
            summary: String(item && item.summary || '').trim()
        }));
        return orderCardsOldest(cloned, newestFirst);
    }

    function screenImportCards(cards, options) {
        const opts = options || {};
        const validCards = [];
        const rejected = [];
        const seen = new Set();
        let duplicateCount = 0;
        (cards || []).forEach((card, index) => {
            const title = String(card && card.title || '').trim();
            const summary = String(card && card.summary || '').trim();
            const normalized = { ...(card || {}), title, summary };
            const reasons = [];
            if (!title) reasons.push('제목이 비어 있습니다.');
            if (!summary) reasons.push('본문이 비어 있습니다.');
            if (title.length > 20) reasons.push(`제목 ${title.length}자 (최대 20자).`);
            if (summary.length > 300) reasons.push(`본문 ${summary.length}자 (최대 300자).`);
            const signature = cardSignature({ title, summary });
            if (!opts.preserveDuplicates && seen.has(signature)) {
                duplicateCount++;
                reasons.push('완전 중복 카드입니다.');
            } else {
                seen.add(signature);
            }
            if (reasons.length) rejected.push({ index: index + 1, title, reasons, card: normalized });
            else validCards.push(normalized);
        });
        return { total: (cards || []).length, validCards, rejected, duplicateCount };
    }

    function validateCards(cards) {
        const screened = screenImportCards(cards);
        const errors = screened.rejected.flatMap(item => item.reasons.map(reason => `${item.index}번째 카드: ${reason}`));
        if (!(cards || []).length) errors.push('카드가 없습니다.');
        return { ok: errors.length === 0, errors, duplicateCount: screened.duplicateCount };
    }

    function formatImportScreeningSummary(source, screened) {
        const name = String(source || '가져오기');
        const valid = screened && screened.validCards ? screened.validCards.length : 0;
        const rejected = screened && screened.rejected ? screened.rejected : [];
        let text = `${name} · 정상 ${valid.toLocaleString()}개 · 제외 ${rejected.length.toLocaleString()}개`;
        if (rejected.length) {
            const first = rejected[0];
            text += ` · 첫 제외 ${first.index}번째${first.title ? ` [${first.title}]` : ''}: ${first.reasons.join(' ')}`;
        }
        return text;
    }



    function isNativeSummary(item) {
        return !!item && String(item.createdBy || '').toLowerCase() === 'assistant' && String(item.badge || '').trim() !== '추가';
    }

    function isZipFile(file) {
        const name = String(file && file.name || '').trim().toLowerCase();
        const type = String(file && file.type || '').trim().toLowerCase();
        return name.endsWith('.zip') || type.includes('zip');
    }

    function normalizeArchiveMeta(raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const hasMeta = ['schemaVersion','kind','chatId','chatTitle','exportedAt','scope'].some(key => raw[key] != null);
        if (!hasMeta) return null;
        return {
            schemaVersion: raw.schemaVersion == null ? null : Number(raw.schemaVersion),
            kind: String(raw.kind || ''),
            chatId: String(raw.chatId || ''),
            chatTitle: String(raw.chatTitle || ''),
            exportedAt: String(raw.exportedAt || ''),
            scope: String(raw.scope || ''),
            order: String(raw.order || '')
        };
    }

    function assertArchivePayloadCount(raw, label) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.count == null) return;
        const rows = Array.isArray(raw.cards) ? raw.cards : (Array.isArray(raw.longTerm) ? raw.longTerm : (Array.isArray(raw.summaries) ? raw.summaries : null));
        if (rows && Number(raw.count) !== rows.length) throw new Error(`${label || '백업'} 카드 개수(count)가 실제 데이터와 맞지 않습니다.`);
    }

    function getImportModeForArchive(bundle) {
        const meta = bundle && bundle.meta;
        if (!meta || meta.kind !== 'crack-long-term-memory') return 'replace';
        if (meta.schemaVersion !== 1) throw new Error(`지원하지 않는 Crack 장기기억 백업 schemaVersion입니다: ${meta.schemaVersion}`);
        if (!String(meta.chatId || '').trim()) throw new Error('Crack 장기기억 백업의 원본 chatId가 없어 복구할 수 없습니다.');
        if (meta.scope === 'all') return 'backup-restore-experimental';
        if (meta.scope === 'selected') return 'backup-selected';
        throw new Error(`지원하지 않는 Crack 장기기억 백업 scope입니다: ${meta.scope || '(없음)'}`);
    }

    function makeImportPlan(imported, existing, options) {
        const opts = options || {};
        const cards = existing || [];
        const orderedImported = orderCardsOldest(imported || [], false);
        const importedCards = opts.includeUserAdded ? orderedImported : orderedImported.filter(card => !isUserAddedSummary(card));
        const ignoredImportedUserCount = orderedImported.length - importedCards.length;
        const editable = orderCardsOldest(cards.filter(item => getSummaryId(item) && (opts.includeUserAdded ? true : isNativeSummary(item))), true);
        const editableSet = new Set(editable);
        const protectedCards = cards.filter(item => !editableSet.has(item));
        const protectedSignatures = new Map();
        for (const item of protectedCards) {
            const sig = cardSignature(item);
            if (!protectedSignatures.has(sig)) protectedSignatures.set(sig, []);
            protectedSignatures.get(sig).push(item);
        }
        const pool = new Map();
        for (const item of editable) {
            const sig = cardSignature(item);
            if (!pool.has(sig)) pool.set(sig, []);
            pool.get(sig).push(item);
        }
        const kept = [];
        const protectedSatisfied = [];
        const unmatched = [];
        for (const card of importedCards) {
            const sig = cardSignature(card);
            const protectedSame = protectedSignatures.get(sig);
            const same = pool.get(sig);
            if (protectedSame && protectedSame.length) protectedSatisfied.push({ card, target: protectedSame[0] });
            else if (same && same.length) kept.push({ card, target: same.shift() });
            else unmatched.push(card);
        }
        const keptTargets = new Set(kept.map(x => x.target));
        const free = editable.filter(item => !keptTargets.has(item));
        const patchCount = Math.min(unmatched.length, free.length);
        const patches = unmatched.slice(0, patchCount).map((card, index) => ({ target: free[index], card }));
        const additions = unmatched.slice(patchCount);
        const deletions = free.slice(patchCount);
        const userCount = Number.isFinite(opts.userCount) ? opts.userCount : cards.filter(isUserAddedSummary).length;
        const userAfter = userCount - deletions.filter(isUserAddedSummary).length + additions.length;
        let blockedReason = '';
        if (additions.length && userAfter > 100) blockedReason = `[추가] 카드가 ${userAfter}개가 되어 크랙 한도(100개)를 넘습니다.`;
        else if (additions.length && opts.isCreatable === false) blockedReason = '크랙이 현재 방을 장기기억 추가 불가 상태로 표시했습니다.';
        return {
            kept, protectedSatisfied, patches, additions, deletions, protectedCards, ignoredImportedUserCount,
            userCount, userAfter, blockedReason,
            expectedFinalCount: cards.length - deletions.length + additions.length,
            sourceSnapshot: snapshotCards(cards)
        };
    }


    function makeBackupRestorePlan(imported, existing, options) {
        const opts = options || {};
        const cards = existing || [];
        const orderedImported = orderCardsOldest(imported || [], false);
        const importedNative = orderedImported.filter(isNativeSummary);
        const importedUsers = orderedImported.filter(isUserAddedSummary);
        const unknownImportedCount = orderedImported.length - importedNative.length - importedUsers.length;
        const nativePool = new Map();
        const userPool = new Map();
        for (const item of cards) {
            const pool = isUserAddedSummary(item) ? userPool : (isNativeSummary(item) ? nativePool : null);
            if (!pool) continue;
            const sig = cardSignature(item);
            if (!pool.has(sig)) pool.set(sig, []);
            pool.get(sig).push(item);
        }
        const consume = (rows, pool) => {
            const kept = [], additions = [];
            for (const card of rows) {
                const same = pool.get(cardSignature(card));
                if (same && same.length) kept.push({ card, target: same.shift() });
                else additions.push(card);
            }
            return { kept, additions };
        };
        const native = consume(importedNative, nativePool);
        const users = consume(importedUsers, userPool);
        const visibleUserCount = cards.filter(isUserAddedSummary).length;
        const declaredUserCount = Number(opts.userCount);
        const currentUserCount = Number.isFinite(declaredUserCount) ? Math.max(visibleUserCount, declaredUserCount) : visibleUserCount;
        const userCapacity = Math.max(0, 100 - currentUserCount);
        const userAdditions = users.additions.slice(0, userCapacity);
        const skippedUserAdditions = users.additions.slice(userCapacity);
        const userAfter = currentUserCount + userAdditions.length;
        const blockedReason = '';
        const archiveMeta = opts.archiveMeta || null;
        const sourceChatId = String(archiveMeta && archiveMeta.chatId || '');
        const targetChatId = String(opts.currentChatId || '');
        return {
            mode: 'backup-restore-experimental', archiveMeta, sourceChatId, targetChatId,
            crossChat: !!sourceChatId && !!targetChatId && !chatIdsMatch(sourceChatId, targetChatId),
            keptNative: native.kept, keptUsers: users.kept,
            nativeAdditions: native.additions, userAdditions, skippedUserAdditions,
            unknownImportedCount, preservedCards: [...cards], currentUserCount, userAfter, blockedReason,
            expectedFinalCount: cards.length + native.additions.length + userAdditions.length,
            sourceSnapshot: snapshotCards(cards)
        };
    }

    function partitionMutationPlan(plan, chunkSize) {
        const size = chunkSize || CHUNK_SIZE;
        const queues = [];
        for (const [type, items] of [['patch', plan.patches || []], ['add', plan.additions || []], ['delete', plan.deletions || []]]) {
            chunkItems(items, size).forEach((part, index, all) => queues.push({ type, part: index + 1, partCount: all.length, items: part }));
        }
        return queues;
    }

    function verifyPlanResult(before, after, plan) {
        const errors = [];
        const afterById = new Map((after || []).map(item => [String(getSummaryId(item) || ''), item]));
        if ((after || []).length !== plan.expectedFinalCount) errors.push(`최종 카드 수가 예상과 다릅니다: ${after.length}/${plan.expectedFinalCount}`);
        for (const item of plan.deletions || []) {
            if (afterById.has(String(getSummaryId(item) || ''))) errors.push(`삭제되지 않은 카드: ${item.title || getSummaryId(item)}`);
        }
        for (const patch of plan.patches || []) {
            const live = afterById.get(String(getSummaryId(patch.target) || ''));
            if (!live || cardSignature(live) !== cardSignature(patch.card)) errors.push(`수정 결과 불일치: ${patch.card.title}`);
        }
        for (const kept of plan.kept || []) {
            const live = afterById.get(String(getSummaryId(kept.target) || ''));
            if (!live || cardSignature(live) !== cardSignature(kept.card)) errors.push(`변경 없음 카드 불일치: ${kept.card.title}`);
        }
        for (const item of plan.protectedCards || []) {
            const live = afterById.get(String(getSummaryId(item) || ''));
            if (!live || cardSignature(live) !== cardSignature(item)) errors.push(`보호 카드 변경 감지: ${item.title || getSummaryId(item)}`);
        }
        const afterSignatures = new Map();
        for (const item of after || []) {
            const sig = cardSignature(item);
            afterSignatures.set(sig, (afterSignatures.get(sig) || 0) + 1);
        }
        for (const card of plan.additions || []) {
            const sig = cardSignature(card);
            if (!(afterSignatures.get(sig) > 0)) errors.push(`추가 결과 불일치: ${card.title}`);
        }
        return { ok: errors.length === 0, errors };
    }


    function verifyBackupRestoreResult(before, after, plan) {
        const errors = [];
        const afterById = new Map((after || []).map(item => [String(getSummaryId(item) || ''), item]));
        if ((after || []).length !== plan.expectedFinalCount) errors.push(`최종 카드 수가 예상과 다릅니다: ${after.length}/${plan.expectedFinalCount}`);
        for (const item of before || []) {
            const id = String(getSummaryId(item) || '');
            const live = afterById.get(id);
            if (!live || cardSignature(live) !== cardSignature(item) || isUserAddedSummary(live) !== isUserAddedSummary(item) || isNativeSummary(live) !== isNativeSummary(item)) {
                errors.push(`기존 카드 보존 실패: ${item.title || id}`);
            }
        }
        const beforeIds = new Set((before || []).map(item => String(getSummaryId(item) || '')));
        const countNew = predicate => {
            const map = new Map();
            for (const item of after || []) {
                const id = String(getSummaryId(item) || '');
                if (beforeIds.has(id) || !predicate(item)) continue;
                const sig = cardSignature(item);
                map.set(sig, (map.get(sig) || 0) + 1);
            }
            return map;
        };
        const native = countNew(isNativeSummary);
        const users = countNew(isUserAddedSummary);
        const consume = (rows, map, label) => {
            for (const card of rows || []) {
                const sig = cardSignature(card), count = map.get(sig) || 0;
                if (!count) errors.push(`${label} 복구 결과 불일치: ${card.title}`);
                else map.set(sig, count - 1);
            }
        };
        consume(plan.nativeAdditions, native, 'native');
        consume(plan.userAdditions, users, '사용자 추가');
        return { ok: errors.length === 0, errors };
    }

    async function applyBackupRestorePlan(plan, hooks) {
        const h = hooks || {};
        if (plan.blockedReason) throw new Error(plan.blockedReason);
        if (plan.crossChat && !h.allowCrossChat) throw new Error(`백업 원본 채팅(${plan.sourceChatId})과 현재 채팅(${plan.targetChatId})이 다릅니다. 분기방 시험 허용이 필요합니다.`);
        const fetchCards = h.fetchCards || (async () => (await fetchAllLongTermMemories()).cards);
        const addNative = h.addNative || (card => addNativeMemoryCard(card));
        const addUser = h.addUser || (card => addMemoryCard(card));
        const deleteProbe = h.deleteProbe || (item => deleteMemoryCard(item));
        const probeWait = h.probeWait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
        const assertReady = h.assertReady || (() => {});
        const onProgress = h.onProgress || (() => {});
        assertReady();
        const before = await fetchCards();
        if (snapshotCards(before) !== plan.sourceSnapshot) throw new Error('복구 계획 이후 서버 장기기억이 변경되어 적용을 중단했습니다.');
        const nativeAdditions = plan.nativeAdditions || [];
        const userAdditions = plan.userAdditions || [];
        const total = nativeAdditions.length + userAdditions.length;
        let addedNative = 0, addedUser = 0;
        if (nativeAdditions.length) {
            const beforeIds = new Set(before.map(item => String(getSummaryId(item) || '')));
            const first = nativeAdditions[0];
            assertReady();
            await addNative(first);
            let createdAll = [], created = [];
            for (let attempt = 0; attempt < 3; attempt++) {
                assertReady();
                const probed = await fetchCards();
                createdAll = probed.filter(item => !beforeIds.has(String(getSummaryId(item) || '')));
                created = createdAll.filter(item => cardSignature(item) === cardSignature(first));
                if (createdAll.length) break;
                if (attempt < 2) await probeWait(800 * (attempt + 1));
            }
            if (createdAll.length !== 1 || created.length !== 1) {
                throw new Error(`native probe 실패: 첫 요청 뒤 신규 카드가 정확히 1개여야 하지만 ${createdAll.length}개가 확인됐습니다.`);
            }
            if (!isNativeSummary(created[0])) {
                const probeId = String(getSummaryId(created[0]) || '');
                try {
                    await deleteProbe(created[0]);
                    let removed = false;
                    for (let attempt = 0; attempt < 3; attempt++) {
                        assertReady();
                        const cleaned = await fetchCards();
                        if (!cleaned.some(item => String(getSummaryId(item) || '') === probeId)) { removed = true; break; }
                        if (attempt < 2) await probeWait(800 * (attempt + 1));
                    }
                    if (!removed) throw new Error(`정리 삭제 후에도 카드 ${probeId || '(ID 없음)'}가 서버에 남아 있습니다.`);
                } catch (cleanupError) { throw new Error(`native 복구 경로 확인 실패: 첫 생성 카드 ${probeId || '(ID 없음)'}가 native가 아니며 정리 삭제도 실패했습니다: ${cleanupError.message}`); }
                throw new Error(`native 복구 경로 확인 실패: 첫 생성 카드 ${probeId || '(ID 없음)'}가 assistant 장기기억으로 확인되지 않아 되돌렸습니다.`);
            }
            addedNative = 1;
            onProgress(makeProgressEvent('restore', addedNative + addedUser, total, { operation:'native' }));
            for (let i = 1; i < nativeAdditions.length; i++) {
                assertReady();
                await addNative(nativeAdditions[i]);
                addedNative++;
                onProgress(makeProgressEvent('restore', addedNative + addedUser, total, { operation:'native' }));
            }
        }
        for (const card of userAdditions) {
            assertReady();
            await addUser(card);
            addedUser++;
            onProgress(makeProgressEvent('restore', addedNative + addedUser, total, { operation:'user' }));
        }
        let after = before;
        let verified = verifyBackupRestoreResult(before, after, plan);
        if (total) {
            for (let attempt = 0; attempt < 3; attempt++) {
                assertReady();
                after = await fetchCards();
                verified = verifyBackupRestoreResult(before, after, plan);
                if (verified.ok) break;
                if (attempt < 2) await probeWait(800 * (attempt + 1));
            }
        }
        if (!verified.ok) throw new Error('백업 복구 서버 검증 실패: ' + verified.errors.join(' / '));
        return { addedNative, addedUser, added: addedNative + addedUser, after };
    }

    async function deleteInWaves(items, del, options) {
        const opts = options || {};
        const assertReady = opts.assertReady || (() => {});
        const onDeleted = opts.onDeleted || (() => {});
        const onConcurrencyChange = opts.onConcurrencyChange || (() => {});
        const onRateLimit = opts.onRateLimit || (() => {});
        const reconcileFailed = opts.reconcileFailed;
        const wait = opts.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
        const tuning = opts.tuningState || {};
        const levels = DELETE_CONCURRENCY_LEVELS;
        const rateWaited = tuning.rateWaited instanceof Set ? tuning.rateWaited : new Set();
        tuning.rateWaited = rateWaited;
        let levelIndex = Number.isInteger(tuning.index) ? Math.max(0, Math.min(levels.length - 1, tuning.index)) : 0;
        let width = levels[levelIndex];
        tuning.index = levelIndex;
        tuning.width = width;
        let pending = [...(items || [])];
        let deleted = 0;
        while (pending.length) {
            const wave = pending.splice(0, width);
            for (const item of wave) assertReady(item);
            const settled = await Promise.allSettled(wave.map(item => del(item)));
            const failed = [];
            let firstError = null, rateError = null;
            for (let j = 0; j < settled.length; j++) {
                if (settled[j].status === 'fulfilled') { deleted++; onDeleted(wave[j], deleted); }
                else {
                    failed.push(wave[j]);
                    if (!firstError) firstError = settled[j].reason;
                    if (!rateError && Number(settled[j].reason && settled[j].reason.status) === 429) rateError = settled[j].reason;
                }
            }
            if (!failed.length) continue;
            let retry = failed;
            if (typeof reconcileFailed === 'function') {
                const remaining = await reconcileFailed(failed);
                const remainingIds = new Set((remaining || []).map(item => String(getSummaryId(item) || '')));
                for (const item of failed) {
                    if (!remainingIds.has(String(getSummaryId(item) || ''))) { deleted++; onDeleted(item, deleted); }
                }
                retry = remaining || [];
            }
            if (!retry.length) continue;
            if (rateError) {
                tuning.rateLimited = true;
                const retryAfterMs = Number(rateError.retryAfterMs);
                if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0 && !rateWaited.has(width)) {
                    rateWaited.add(width);
                    onRateLimit({ concurrency: width, retryAfterMs, failed: retry.length });
                    await wait(retryAfterMs);
                    pending = [...retry, ...pending];
                    continue;
                }
                tuning.uncertain = true;
            }
            if (levelIndex >= levels.length - 1) throw firstError || new Error('DELETE 실패');
            tuning.uncertain = true;
            const from = width;
            levelIndex++;
            width = levels[levelIndex];
            tuning.index = levelIndex;
            tuning.width = width;
            onConcurrencyChange({ from, to: width, failed: retry.length, reason: rateError ? 'rate-limit-or-failure' : 'failure' });
            pending = [...retry, ...pending];
        }
        return deleted;
    }

    async function reconcileDeleteFailures(failed, fetchCards) {
        const live = await fetchCards();
        const liveById = new Map(live.map(item => [String(getSummaryId(item) || ''), item]));
        const remaining = [];
        for (const item of failed || []) {
            const current = liveById.get(String(getSummaryId(item) || ''));
            if (!current) continue;
            if (cardSignature(current) !== cardSignature(item)) throw new Error(`삭제 대상이 작업 중 변경되었습니다: ${item.title || getSummaryId(item)}`);
            remaining.push(item);
        }
        return remaining;
    }

    async function applyImportPlan(plan, hooks) {
        const h = hooks || {};
        if (plan.blockedReason) throw new Error(plan.blockedReason);
        const fetchCards = h.fetchCards || (async () => (await fetchAllLongTermMemories()).cards);
        const assertReady = h.assertReady || (() => {});
        assertReady();
        const before = await fetchCards();
        if (snapshotCards(before) !== plan.sourceSnapshot) throw new Error('미리보기 이후 서버 장기기억이 변경되어 적용을 중단했습니다.');
        const patch = h.patch || (entry => updateMemoryCard(entry.target, entry.card));
        const add = h.add || (card => addMemoryCard(card));
        const del = h.delete || (item => deleteMemoryCard(item));
        const onProgress = h.onProgress || (() => {});
        const onDeleteConcurrency = h.onDeleteConcurrency || (() => {});
        const onDeleteRateLimit = h.onDeleteRateLimit || (() => {});
        const deleteTuning = {};
        let completed = 0;
        const totalWrites = (plan.patches || []).length + (plan.additions || []).length + (plan.deletions || []).length;
        const result = { patched: 0, added: 0, deleted: 0 };
        for (const queue of partitionMutationPlan(plan)) {
            if (queue.type === 'delete') {
                assertReady();
                const live = await fetchCards();
                const liveById = new Map(live.map(item => [String(getSummaryId(item) || ''), item]));
                for (const item of queue.items) {
                    const current = liveById.get(String(getSummaryId(item) || ''));
                    if (!current || cardSignature(current) !== cardSignature(item)) throw new Error(`삭제 대상이 작업 중 변경되었습니다: ${item.title || getSummaryId(item)}`);
                }
            }
            if (queue.type === 'delete') {
                await deleteInWaves(queue.items, del, {
                    assertReady,
                    tuningState: deleteTuning,
                    onConcurrencyChange: onDeleteConcurrency,
                    onRateLimit: onDeleteRateLimit,
                    reconcileFailed: failed => { assertReady(); return reconcileDeleteFailures(failed, fetchCards); },
                    onDeleted: () => {
                        result.deleted++;
                        completed++;
                        onProgress(makeProgressEvent('apply', completed, totalWrites, { operation: queue.type, part: queue.part, partCount: queue.partCount, concurrency: deleteTuning.width }));
                    }
                });
            } else {
                for (const item of queue.items) {
                    assertReady();
                    if (queue.type === 'patch') { await patch(item); result.patched++; }
                    else { await add(item); result.added++; }
                    completed++;
                    onProgress(makeProgressEvent('apply', completed, totalWrites, { operation: queue.type, part: queue.part, partCount: queue.partCount }));
                }
            }
        }
        assertReady();
        const after = await fetchCards();
        const verified = verifyPlanResult(before, after, plan);
        if (!verified.ok) throw new Error('서버 반영 검증 실패: ' + verified.errors.join(' / '));
        return { ...result, after, deleteConcurrency: result.deleted ? deleteTuning.width : null, deleteRateLimited: !!deleteTuning.rateLimited, deleteConcurrencyCertain: !deleteTuning.uncertain };
    }



    function buildDeletePlan(targets, current) {
        const seen = new Set();
        const deletions = [];
        for (const item of targets || []) {
            const id = String(getSummaryId(item) || '');
            if (!id || seen.has(id)) continue;
            seen.add(id);
            deletions.push(item);
        }
        const deleteIds = new Set(deletions.map(item => String(getSummaryId(item) || '')));
        return {
            deletions,
            survivors: (current || []).filter(item => !deleteIds.has(String(getSummaryId(item) || ''))),
            parts: chunkItems(deletions, CHUNK_SIZE),
            expectedFinalCount: Math.max(0, (current || []).length - deletions.length),
            sourceSnapshot: snapshotCards(current || [])
        };
    }

    async function applyDeletePlan(plan, hooks) {
        const h = hooks || {};
        const fetchCards = h.fetchCards || (async () => (await fetchAllLongTermMemories()).cards);
        const del = h.delete || (item => deleteMemoryCard(item));
        const onProgress = h.onProgress || (() => {});
        const assertReady = h.assertReady || (() => {});
        const onDeleteConcurrency = h.onDeleteConcurrency || (() => {});
        const onDeleteRateLimit = h.onDeleteRateLimit || (() => {});
        const deleteTuning = {};
        assertReady();
        const before = await fetchCards();
        if (snapshotCards(before) !== plan.sourceSnapshot) throw new Error('삭제 미리보기 이후 서버 장기기억이 변경되어 작업을 중단했습니다.');
        let deleted = 0;
        const totalDeletes = (plan.deletions || []).length;
        for (let p = 0; p < plan.parts.length; p++) {
            const part = plan.parts[p];
            if (p > 0) {
                assertReady();
                const live = await fetchCards();
                const liveById = new Map(live.map(item => [String(getSummaryId(item) || ''), item]));
                for (const item of part) {
                    const current = liveById.get(String(getSummaryId(item) || ''));
                    if (!current || cardSignature(current) !== cardSignature(item)) throw new Error(`삭제 대상이 작업 중 변경되었습니다: ${item.title || getSummaryId(item)}`);
                }
            }
            await deleteInWaves(part, del, {
                assertReady,
                tuningState: deleteTuning,
                onConcurrencyChange: onDeleteConcurrency,
                onRateLimit: onDeleteRateLimit,
                reconcileFailed: failed => { assertReady(); return reconcileDeleteFailures(failed, fetchCards); },
                onDeleted: () => {
                    deleted++;
                    onProgress(makeProgressEvent('delete', deleted, totalDeletes, { part: p + 1, partCount: plan.parts.length, concurrency: deleteTuning.width }));
                }
            });
        }
        assertReady();
        const after = await fetchCards();
        const afterById = new Map(after.map(item => [String(getSummaryId(item) || ''), item]));
        const remaining = plan.deletions.filter(item => afterById.has(String(getSummaryId(item) || '')));
        const changedSurvivors = (plan.survivors || []).filter(item => {
            const live = afterById.get(String(getSummaryId(item) || ''));
            return !live || cardSignature(live) !== cardSignature(item);
        });
        if (remaining.length || changedSurvivors.length || after.length !== plan.expectedFinalCount || (h.requireEmpty && after.length !== 0)) {
            throw new Error(`삭제 결과 검증 실패: 예상 ${plan.expectedFinalCount}개 / 실제 ${after.length}개 / 삭제 대상 잔존 ${remaining.length}개 / 보존 카드 변경 ${changedSurvivors.length}개`);
        }
        return { deleted, after, deleteConcurrency: deleted ? deleteTuning.width : null, deleteRateLimited: !!deleteTuning.rateLimited, deleteConcurrencyCertain: !deleteTuning.uncertain };
    }

    function getPagination(total, page, pageSize) {
        const size = pageSize || 200;
        const count = Math.max(1, Math.ceil(Math.max(0, total) / size));
        const current = Math.min(count, Math.max(1, Number(page) || 1));
        const start = (current - 1) * size;
        return { page: current, pageSize: size, pageCount: count, start, end: Math.min(total, start + size) };
    }

    function buildArchiveText(cards) {
        return orderCardsOldest(cards || [], true).map(card => JSON.stringify({
            title: String(card && card.title || ''),
            summary: String(card && card.summary || '')
        })).join('\n');
    }

    function buildArchivePayload(cards, meta, scope) {
        const m = meta || {};
        return {
            schemaVersion: 1,
            kind: 'crack-long-term-memory',
            chatId: String(m.chatId || ''),
            chatTitle: String(m.chatTitle || ''),
            exportedAt: String(m.exportedAt || new Date().toISOString()),
            scope: String(scope || m.scope || 'all'),
            order: 'newest-first',
            count: (cards || []).length,
            cards: (cards || []).map(card => Object.assign({}, card || {}, {
                id: getSummaryId(card) || '',
                title: String(card && card.title || ''),
                summary: String(card && card.summary || '')
            }))
        };
    }

    function buildArchiveFiles(cards, meta, scope) {
        const rows = cards || [];
        const files = new Map();
        if (rows.length <= CHUNK_SIZE) {
            files.set('memories.json', JSON.stringify(buildArchivePayload(rows, meta, scope), null, 2));
            files.set('memories.txt', buildArchiveText(rows));
            return files;
        }
        const chunks = chunkItems(rows, CHUNK_SIZE);
        const parts = chunks.map((chunk, index) => {
            const number = String(index + 1).padStart(4, '0');
            const start = index * CHUNK_SIZE + 1;
            return {
                json: `memories_${number}.json`,
                txt: `memories_${number}.txt`,
                start,
                end: start + chunk.length - 1,
                count: chunk.length
            };
        });
        const manifest = buildArchiveManifest({ ...(meta || {}), scope: scope || 'all' }, parts);
        files.set('manifest.json', JSON.stringify(manifest, null, 2));
        chunks.forEach((chunk, index) => {
            const part = parts[index];
            files.set(part.json, JSON.stringify(buildArchivePayload(chunk, meta, scope), null, 2));
            files.set(part.txt, buildArchiveText(chunk));
        });
        return files;
    }

    const STORE_ZIP_ENCODER = new TextEncoder();
    const STORE_ZIP_CRC_TABLE = (() => {
        const table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            table[n] = c >>> 0;
        }
        return table;
    })();

    function storeZipHeader(size, write) {
        const out = new Uint8Array(size);
        write(new DataView(out.buffer));
        return out;
    }

    async function storeZipCrc32(blob, onBytes) {
        let crc = 0xFFFFFFFF;
        let sinceYield = 0;
        const reader = blob.stream().getReader();
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                for (const byte of value) crc = STORE_ZIP_CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
                onBytes(value.byteLength);
                sinceYield += value.byteLength;
                if (sinceYield >= 4 * 1024 * 1024) {
                    sinceYield = 0;
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }
        } finally {
            try { reader.releaseLock(); } catch (_) {}
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    async function buildStoreZipBlob(files, onProgress) {
        const rows = [...files].map(([name, content]) => ({ name, nameBytes: STORE_ZIP_ENCODER.encode(name), blob: new Blob([content]) }));
        if (rows.length > 65535) throw new Error('ZIP32 파일 개수 한도를 넘었습니다.');
        const totalBytes = rows.reduce((sum, row) => sum + row.blob.size, 0);
        let processedBytes = 0;
        const report = typeof onProgress === 'function' ? onProgress : () => {};
        const reportBytes = (bytes, currentFile) => {
            processedBytes += bytes;
            report(makeProgressEvent('zip', processedBytes, totalBytes || 1, { currentFile }));
        };
        const parts = [];
        const central = [];
        let offset = 0;
        const d = new Date();
        const year = Math.max(1980, d.getFullYear());
        const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31);
        const date = (((year - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
        for (const row of rows) {
            if (row.blob.size > 0xFFFFFFFF) throw new Error('단일 백업 파일이 ZIP32 크기 한도를 넘었습니다.');
            const crc = await storeZipCrc32(row.blob, bytes => reportBytes(bytes, row.name));
            const localOffset = offset;
            const local = storeZipHeader(30, view => {
                view.setUint32(0, 0x04034b50, true);
                view.setUint16(4, 20, true);
                view.setUint16(6, 0x0800, true);
                view.setUint16(8, 0, true);
                view.setUint16(10, time, true);
                view.setUint16(12, date, true);
                view.setUint32(14, crc, true);
                view.setUint32(18, row.blob.size, true);
                view.setUint32(22, row.blob.size, true);
                view.setUint16(26, row.nameBytes.length, true);
            });
            parts.push(local, row.nameBytes, row.blob);
            offset += local.length + row.nameBytes.length + row.blob.size;
            if (offset > 0xFFFFFFFF) throw new Error('ZIP32 총 크기 한도를 넘었습니다.');
            central.push({ ...row, crc, localOffset });
        }
        const centralOffset = offset;
        for (const row of central) {
            const header = storeZipHeader(46, view => {
                view.setUint32(0, 0x02014b50, true);
                view.setUint16(4, 20, true);
                view.setUint16(6, 20, true);
                view.setUint16(8, 0x0800, true);
                view.setUint16(10, 0, true);
                view.setUint16(12, time, true);
                view.setUint16(14, date, true);
                view.setUint32(16, row.crc, true);
                view.setUint32(20, row.blob.size, true);
                view.setUint32(24, row.blob.size, true);
                view.setUint16(28, row.nameBytes.length, true);
                view.setUint32(42, row.localOffset, true);
            });
            parts.push(header, row.nameBytes);
            offset += header.length + row.nameBytes.length;
        }
        const centralSize = offset - centralOffset;
        parts.push(storeZipHeader(22, view => {
            view.setUint32(0, 0x06054b50, true);
            view.setUint16(8, central.length, true);
            view.setUint16(10, central.length, true);
            view.setUint32(12, centralSize, true);
            view.setUint32(16, centralOffset, true);
        }));
        report(makeProgressEvent('zip', totalBytes || 1, totalBytes || 1, { currentFile: null }));
        return new Blob(parts, { type: 'application/zip' });
    }

    async function buildZipBlob(cards, meta, scope, onProgress) {
        const report = typeof onProgress === 'function' ? onProgress : () => {};
        report(makeProgressEvent('zip', 0, 100, { currentFile: '백업 파일 구성' }));
        return buildStoreZipBlob(buildArchiveFiles(cards, meta, scope), report);
    }

    function storeZipFallback(message) {
        const error = new Error(message || 'native STORE ZIP으로 읽을 수 없습니다.');
        error.code = 'CLMM_ZIP_FALLBACK';
        return error;
    }

    function indexStoreZip(buffer) {
        const bytes = new Uint8Array(buffer);
        const view = new DataView(buffer);
        let eocd = -1;
        const min = Math.max(0, bytes.length - 65557);
        for (let i = bytes.length - 22; i >= min; i--) {
            if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) throw storeZipFallback('ZIP 중앙 디렉터리를 찾지 못했습니다.');
        if (view.getUint16(eocd + 4, true) || view.getUint16(eocd + 6, true)) throw storeZipFallback('다중 디스크 ZIP은 native 경로에서 지원하지 않습니다.');
        const count = view.getUint16(eocd + 10, true);
        const centralSize = view.getUint32(eocd + 12, true);
        const centralOffset = view.getUint32(eocd + 16, true);
        if (centralOffset + centralSize > eocd || centralOffset > bytes.length) throw storeZipFallback('ZIP 중앙 디렉터리 범위가 올바르지 않습니다.');
        const decoder = new TextDecoder('utf-8');
        const entries = new Map();
        let offset = centralOffset;
        for (let i = 0; i < count; i++) {
            if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) throw storeZipFallback('ZIP 중앙 디렉터리 항목이 올바르지 않습니다.');
            const method = view.getUint16(offset + 10, true);
            const crc = view.getUint32(offset + 16, true);
            const compressedSize = view.getUint32(offset + 20, true);
            const uncompressedSize = view.getUint32(offset + 24, true);
            const nameLength = view.getUint16(offset + 28, true);
            const extraLength = view.getUint16(offset + 30, true);
            const commentLength = view.getUint16(offset + 32, true);
            const localOffset = view.getUint32(offset + 42, true);
            if (method !== 0 || compressedSize !== uncompressedSize) throw storeZipFallback('압축 ZIP은 JSZip fallback이 필요합니다.');
            if (compressedSize === 0xFFFFFFFF || localOffset === 0xFFFFFFFF) throw storeZipFallback('ZIP64는 native 경로에서 지원하지 않습니다.');
            const nameStart = offset + 46;
            const nameEnd = nameStart + nameLength;
            if (nameEnd > bytes.length) throw storeZipFallback('ZIP 파일명이 손상되었습니다.');
            const name = decoder.decode(bytes.subarray(nameStart, nameEnd));
            if (entries.has(name)) throw new Error(`ZIP 안에 같은 파일명이 중복됩니다: ${name}`);
            if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) throw storeZipFallback('ZIP 로컬 헤더가 올바르지 않습니다.');
            const localMethod = view.getUint16(localOffset + 8, true);
            const localNameLength = view.getUint16(localOffset + 26, true);
            const localExtraLength = view.getUint16(localOffset + 28, true);
            if (localMethod !== 0) throw storeZipFallback('압축 ZIP은 JSZip fallback이 필요합니다.');
            const dataStart = localOffset + 30 + localNameLength + localExtraLength;
            const dataEnd = dataStart + compressedSize;
            if (dataEnd > bytes.length) throw storeZipFallback('ZIP 파일 데이터 범위가 올바르지 않습니다.');
            entries.set(name, { crc, dataStart, dataEnd });
            offset = nameEnd + extraLength + commentLength;
        }
        return { bytes, entries };
    }

    async function storeZipCrc32Bytes(bytes) {
        let crc = 0xFFFFFFFF;
        let sinceYield = 0;
        for (let i = 0; i < bytes.length; i++) {
            crc = STORE_ZIP_CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
            if (++sinceYield >= 4 * 1024 * 1024) {
                sinceYield = 0;
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    async function readStoreZipEntryText(index, name) {
        const entry = index.entries.get(name);
        if (!entry) return null;
        const bytes = index.bytes.subarray(entry.dataStart, entry.dataEnd);
        if (await storeZipCrc32Bytes(bytes) !== entry.crc) throw new Error(`ZIP CRC 검증 실패: ${name}`);
        return new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
    }

    async function readNativeStoreArchiveBundle(buffer, onProgress) {
        const report = typeof onProgress === 'function' ? onProgress : () => {};
        const index = indexStoreZip(buffer);
        if (index.entries.has('manifest.json')) {
            report(makeProgressEvent('import-unpack', 0, 1));
            const manifest = JSON.parse(await readStoreZipEntryText(index, 'manifest.json'));
            report(makeProgressEvent('import-unpack', 1, 1));
            const parts = new Map();
            const list = manifest.parts || [];
            for (let i = 0; i < list.length; i++) {
                const part = list[i];
                const text = await readStoreZipEntryText(index, part.json);
                if (text == null) throw new Error(`분할 파일이 누락되었습니다: ${part.json}`);
                parts.set(part.json, JSON.parse(text));
                report(makeProgressEvent('import-parse', i + 1, list.length || 1));
            }
            return { cards: mergeArchiveParts(manifest, parts), meta: normalizeArchiveMeta(manifest), sourceFormat:'zip-manifest' };
        }
        if (index.entries.has('memories.json')) {
            report(makeProgressEvent('import-unpack', 0, 1));
            const text = await readStoreZipEntryText(index, 'memories.json');
            report(makeProgressEvent('import-unpack', 1, 1));
            report(makeProgressEvent('import-parse', 1, 1));
            const raw = JSON.parse(text);
            assertArchivePayloadCount(raw, 'memories.json');
            return { cards: normalizeArchiveJson(raw), meta: normalizeArchiveMeta(raw), sourceFormat:'zip-json' };
        }
        if (index.entries.has('memories.txt')) {
            report(makeProgressEvent('import-unpack', 0, 1));
            const text = await readStoreZipEntryText(index, 'memories.txt');
            report(makeProgressEvent('import-unpack', 1, 1));
            report(makeProgressEvent('import-parse', 1, 1));
            return { cards: parseMemoryText(text), meta:null, sourceFormat:'zip-txt' };
        }
        throw new Error('ZIP에서 manifest.json 또는 memories.json/memories.txt를 찾지 못했습니다.');
    }

    function buildArchiveManifest(meta, parts) {
        return {
            schemaVersion: 1,
            kind: 'crack-long-term-memory',
            chatId: String(meta && meta.chatId || ''),
            chatTitle: String(meta && meta.chatTitle || ''),
            exportedAt: String(meta && meta.exportedAt || new Date().toISOString()),
            scope: String(meta && meta.scope || 'all'),
            order: 'newest-first',
            totalCount: parts.reduce((sum, part) => sum + part.count, 0),
            chunkSize: CHUNK_SIZE,
            partCount: parts.length,
            parts
        };
    }

    function mergeArchiveParts(manifest, partMap) {
        if (!manifest || !Array.isArray(manifest.parts) || manifest.partCount !== manifest.parts.length) throw new Error('manifest part 정보가 올바르지 않습니다.');
        const cards = [];
        let expectedStart = 1;
        let order = manifest.order || '';
        const names = new Set();
        for (const part of manifest.parts) {
            if (!part || !part.json || names.has(part.json)) throw new Error('manifest part 파일명이 중복되었거나 비어 있습니다.');
            names.add(part.json);
            if (part.start !== expectedStart || part.end !== part.start + part.count - 1) throw new Error('manifest part 순서 또는 범위가 올바르지 않습니다.');
            const raw = partMap.get(part.json);
            if (!raw) throw new Error(`분할 파일이 누락되었습니다: ${part.json}`);
            const rows = Array.isArray(raw) ? raw : raw && (raw.cards || raw.longTerm || raw.summaries);
            if (!Array.isArray(rows)) throw new Error(`분할 파일 카드 배열이 올바르지 않습니다: ${part.json}`);
            if (rows.length !== part.count) throw new Error(`분할 파일 카드 개수가 맞지 않습니다: ${part.json}`);
            assertArchivePayloadCount(raw, part.json);
            if (manifest.kind === 'crack-long-term-memory' && raw && typeof raw === 'object' && !Array.isArray(raw)) {
                for (const key of ['schemaVersion','kind','chatId','scope','order']) {
                    if (raw[key] != null && String(raw[key]) !== String(manifest[key] == null ? '' : manifest[key])) {
                        throw new Error(`분할 백업 메타데이터(${key})가 manifest와 다릅니다: ${part.json}`);
                    }
                }
            }
            if (!order && raw && typeof raw === 'object' && !Array.isArray(raw)) order = String(raw.order || '');
            cards.push(...rows);
            expectedStart = part.end + 1;
        }
        if (cards.length !== manifest.totalCount) throw new Error('manifest 전체 카드 개수가 실제 데이터와 맞지 않습니다.');
        return normalizeArchiveJson({ cards, order: order || 'oldest-first' });
    }



    const MAX_INPUT_FILE_BYTES = 32 * 1024 * 1024;

    function sanitizeFileName(value) {
        return String(value || 'chat').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50) || 'chat';
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
    }

    async function readArchiveBundle(file, ZipClass, onProgress) {
        if (!file) throw new Error('파일을 선택해주세요.');
        if (file.size > MAX_INPUT_FILE_BYTES) throw new Error('32MiB 이하 파일을 선택해주세요.');
        const report = typeof onProgress === 'function' ? onProgress : () => {};
        const name = String(file.name || '').toLowerCase();
        report(makeProgressEvent('import-read', 0, 1));
        if (isZipFile(file)) {
            const buffer = await file.arrayBuffer();
            report(makeProgressEvent('import-read', 1, 1));
            try { return await readNativeStoreArchiveBundle(buffer, report); }
            catch (nativeError) {
                if (nativeError && nativeError.code !== 'CLMM_ZIP_FALLBACK') throw nativeError;
                const Ctor = ZipClass || (typeof JSZip !== 'undefined' ? JSZip : null);
                if (!Ctor) throw nativeError || new Error('ZIP 라이브러리를 불러오지 못했습니다.');
                report(makeProgressEvent('import-unpack', 0, 1, { fallback:true }));
                const zip = await Ctor.loadAsync(buffer, { checkCRC32:true });
                report(makeProgressEvent('import-unpack', 1, 1, { fallback:true }));
                if (zip.file('manifest.json')) {
                    const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
                    const parts = new Map();
                    const list = manifest.parts || [];
                    for (let i = 0; i < list.length; i++) {
                        const part = list[i], entry = zip.file(part.json);
                        if (!entry) throw new Error(`분할 파일이 누락되었습니다: ${part.json}`);
                        parts.set(part.json, JSON.parse(await entry.async('string')));
                        report(makeProgressEvent('import-parse', i + 1, list.length || 1, { fallback:true }));
                    }
                    return { cards: mergeArchiveParts(manifest, parts), meta: normalizeArchiveMeta(manifest), sourceFormat:'zip-manifest' };
                }
                if (zip.file('memories.json')) {
                    const raw = JSON.parse(await zip.file('memories.json').async('string'));
                    assertArchivePayloadCount(raw, 'memories.json');
                    report(makeProgressEvent('import-parse', 1, 1, { fallback:true }));
                    return { cards: normalizeArchiveJson(raw), meta: normalizeArchiveMeta(raw), sourceFormat:'zip-json' };
                }
                if (zip.file('memories.txt')) {
                    const cards = parseMemoryText(await zip.file('memories.txt').async('string'));
                    report(makeProgressEvent('import-parse', 1, 1, { fallback:true }));
                    return { cards, meta:null, sourceFormat:'zip-txt' };
                }
                throw new Error('ZIP에서 manifest.json 또는 memories.json/memories.txt를 찾지 못했습니다.');
            }
        }
        const text = (await file.text()).replace(/^﻿/, '');
        report(makeProgressEvent('import-read', 1, 1));
        report(makeProgressEvent('import-parse', 0, 1));
        if (name.endsWith('.json')) {
            const raw = JSON.parse(text);
            assertArchivePayloadCount(raw, name || 'JSON');
            report(makeProgressEvent('import-parse', 1, 1));
            return { cards: normalizeArchiveJson(raw), meta: normalizeArchiveMeta(raw), sourceFormat:'json' };
        }
        if (name.endsWith('.txt')) {
            const cards = parseMemoryText(text);
            report(makeProgressEvent('import-parse', 1, 1));
            return { cards, meta:null, sourceFormat:'txt' };
        }
        throw new Error('ZIP, JSON, TXT 파일만 지원합니다.');
    }

    async function readArchiveFile(file, ZipClass, onProgress) {
        return (await readArchiveBundle(file, ZipClass, onProgress)).cards;
    }

    function formatTimestamp(date) {
        return date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    }

    function injectStyles() {
        if (document.getElementById('clmm-style')) return;
        const style = document.createElement('style');
        style.id = 'clmm-style';
        style.textContent = `
#clmm-open{position:fixed;right:18px;bottom:84px;z-index:2147483000;border:0;border-radius:999px;padding:11px 15px;background:#1f2937;color:#fff;font:600 13px system-ui;box-shadow:0 6px 24px #0004;cursor:pointer}
#clmm-overlay{position:fixed;inset:0;z-index:2147483001;background:#0009;display:flex;align-items:center;justify-content:center;padding:18px;font-family:system-ui,sans-serif;color:#111827}
#clmm-overlay[hidden]{display:none}
#clmm-modal{position:relative;width:min(1180px,96vw);height:min(900px,94vh);background:#fff;border-radius:14px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 70px #0008}
.clmm-head{display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid #e5e7eb}.clmm-head h2{margin:0;font-size:18px}.clmm-grow{flex:1}.clmm-close{border:0;background:transparent;font-size:24px;cursor:pointer}
.clmm-body{padding:12px 16px;overflow:auto}.clmm-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}.clmm-stats{font-size:13px;color:#374151}.clmm-status{white-space:pre-wrap;background:#f3f4f6;border-radius:8px;padding:8px 10px;font-size:12px;min-height:18px}.clmm-progress{margin-top:7px}.clmm-progress-meta{font-variant-numeric:tabular-nums;margin-bottom:5px}.clmm-progress-track{height:7px;border-radius:999px;background:#d1d5db;overflow:hidden}.clmm-progress-bar{height:100%;width:0;background:#4b5563;transition:width .12s linear}.clmm-progress-bar.indeterminate{width:35%;animation:clmm-progress-slide 1s linear infinite}@keyframes clmm-progress-slide{from{transform:translateX(-110%)}to{transform:translateX(300%)}}
.clmm-btn{border:1px solid #d1d5db;background:#fff;border-radius:7px;padding:7px 10px;cursor:pointer;font-size:12px}.clmm-btn:hover{background:#f9fafb}.clmm-btn:disabled{opacity:.45;cursor:not-allowed}.clmm-primary{background:#2563eb;color:#fff;border-color:#2563eb}.clmm-danger{background:#b91c1c;color:#fff;border-color:#b91c1c}
.clmm-list{border:1px solid #e5e7eb;border-radius:10px;overflow:hidden}.clmm-card{display:grid;grid-template-columns:28px 52px minmax(130px,260px) 1fr;gap:8px;padding:8px 10px;border-bottom:1px solid #eef0f2;align-items:start}.clmm-card:last-child{border-bottom:0}.clmm-badge{font-size:11px;border-radius:999px;padding:2px 6px;background:#e5e7eb;text-align:center}.clmm-badge.user{background:#fef3c7;color:#92400e}.clmm-title{font-weight:650;font-size:13px;word-break:break-word}.clmm-summary{font-size:12px;line-height:1.45;white-space:pre-wrap;word-break:break-word;color:#374151}
.clmm-pages{display:flex;align-items:center;justify-content:center;gap:10px;margin:10px 0}.clmm-import{margin-top:14px;border-top:1px solid #e5e7eb;padding-top:12px}.clmm-import textarea{width:100%;min-height:160px;resize:vertical;box-sizing:border-box;border:1px solid #d1d5db;border-radius:8px;padding:9px;font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}.clmm-preview{white-space:pre-wrap;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:9px;font-size:12px;min-height:18px}
.clmm-confirm-backdrop{position:absolute;inset:0;background:#0008;display:flex;align-items:center;justify-content:center;z-index:5}.clmm-confirm{width:min(560px,88vw);background:white;border-radius:12px;padding:18px;box-shadow:0 20px 60px #0008}.clmm-confirm h3{margin:0 0 10px}.clmm-confirm p{white-space:pre-wrap;font-size:13px;line-height:1.5}.clmm-confirm-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
@media(max-width:760px){.clmm-card{grid-template-columns:26px 48px 1fr}.clmm-summary{grid-column:3}.clmm-body{padding:10px}}
`;
        document.head.appendChild(style);
    }

    function deleteBackupChoice(root, title, message) {
        return new Promise(resolve => {
            const backdrop = document.createElement('div');
            backdrop.className = 'clmm-confirm-backdrop';
            const box = document.createElement('div');
            box.className = 'clmm-confirm';
            const h = document.createElement('h3');
            h.textContent = title;
            const p = document.createElement('p');
            p.textContent = `${message}\n\n확인: 전체 ZIP 백업 후 삭제\n필요없음: 백업 없이 삭제`;
            const actions = document.createElement('div');
            actions.className = 'clmm-confirm-actions';
            const cancel = document.createElement('button');
            cancel.className = 'clmm-btn';
            cancel.textContent = '취소';
            const skip = document.createElement('button');
            skip.className = 'clmm-btn clmm-danger';
            skip.textContent = '필요없음';
            const backup = document.createElement('button');
            backup.className = 'clmm-btn clmm-primary';
            backup.textContent = '확인';
            function done(value) { backdrop.remove(); resolve(value); }
            cancel.addEventListener('click', () => done(null));
            skip.addEventListener('click', () => done(false));
            backup.addEventListener('click', () => done(true));
            actions.append(cancel, skip, backup);
            box.append(h, p, actions);
            backdrop.appendChild(box);
            root.appendChild(backdrop);
        });
    }

    function initUi() {
        if (document.getElementById('clmm-open')) return;
        injectStyles();
        const open = document.createElement('button');
        open.id = 'clmm-open';
        open.textContent = '장기기억 관리';
        document.body.appendChild(open);

        const overlay = document.createElement('div');
        overlay.id = 'clmm-overlay';
        overlay.hidden = true;
        overlay.innerHTML = `
<div id="clmm-modal" role="dialog" aria-modal="true" aria-label="장기기억 관리">
  <div class="clmm-head"><h2>Crack 장기기억 관리</h2><span class="clmm-stats">v0.1.10</span><div class="clmm-grow"></div><button class="clmm-close" id="clmm-close" aria-label="닫기">×</button></div>
  <div class="clmm-body">
    <div class="clmm-row clmm-stats" id="clmm-stats">불러오지 않음</div>
    <div class="clmm-row">
      <label><input id="clmm-select-native" type="checkbox"> 전체 선택</label>
      <button class="clmm-btn" id="clmm-refresh">새로고침</button>
      <button class="clmm-btn" id="clmm-export-read-log" disabled>조회 로그 TXT</button>
      <button class="clmm-btn" id="clmm-export-all">전체 ZIP 백업</button>
      <button class="clmm-btn" id="clmm-export-selected" disabled>선택 ZIP 내보내기</button>
      <button class="clmm-btn" id="clmm-import-file-btn">가져오기 파일</button>
      <input id="clmm-import-file" type="file" accept=".zip,.json,.txt" hidden>
      <button class="clmm-btn clmm-danger" id="clmm-delete-selected" disabled>장기기억 삭제</button>
      <button class="clmm-btn clmm-danger" id="clmm-delete-all">장기기억 전체 삭제(사용자 추가 카드 포함)</button>
    </div>
    <div class="clmm-status"><div id="clmm-status-text">현재 방의 장기기억을 불러오세요.</div><div class="clmm-progress" id="clmm-progress" hidden><div class="clmm-progress-meta" id="clmm-progress-meta"></div><div class="clmm-progress-track"><div class="clmm-progress-bar" id="clmm-progress-bar"></div></div></div></div>
    <div class="clmm-list" id="clmm-list"></div>
    <div class="clmm-pages"><button class="clmm-btn" id="clmm-prev">이전</button><span id="clmm-page">1 / 1</span><button class="clmm-btn" id="clmm-next">다음</button></div>
    <section class="clmm-import">
      <h3>외부 AI 편집 결과 가져오기</h3>
      <textarea id="clmm-import-text" placeholder='{"title":"제목","summary":"본문"}&#10;{"title":"다음 제목","summary":"본문"}'></textarea>
      <div class="clmm-row">
        <button class="clmm-btn" id="clmm-validate-text">붙여넣은 결과 검증</button>
        <label><input id="clmm-protect-user" type="checkbox" checked> 사용자 추가 카드 보호</label>
        <button class="clmm-btn" id="clmm-preview-import" disabled>전체 교체 미리보기</button>
        <button class="clmm-btn clmm-primary" id="clmm-apply-import" disabled>전체 교체 적용</button>
      </div>
      <div class="clmm-preview" id="clmm-import-preview">가져온 데이터 없음</div>
    </section>
  </div>
</div>`;
        document.body.appendChild(overlay);

        const el = id => overlay.querySelector('#' + id);
        const state = { chatId: '', cards: [], meta: {}, selectedIds: new Set(), page: 1, importedCards: null, importRejected: [], importPlan: null, importMode: null, archiveMeta: null, busy: false };
        const actions = ['clmm-refresh','clmm-export-read-log','clmm-export-all','clmm-export-selected','clmm-import-file-btn','clmm-delete-selected','clmm-delete-all','clmm-validate-text','clmm-preview-import','clmm-apply-import','clmm-prev','clmm-next','clmm-select-native','clmm-protect-user'];

        function status(message) { el('clmm-status-text').textContent = message; }
        function clearProgress() {
            el('clmm-progress').hidden = true;
            const bar = el('clmm-progress-bar');
            bar.classList.remove('indeterminate');
            bar.style.width = '0%';
        }
        function showProgress(event) {
            if (!event || typeof event !== 'object') { if (event) status(String(event)); return; }
            const box = el('clmm-progress');
            const bar = el('clmm-progress-bar');
            box.hidden = false;
            el('clmm-progress-meta').textContent = formatProgressText(event);
            if (Number.isFinite(event.percent)) {
                bar.classList.remove('indeterminate');
                bar.style.width = Math.max(0, Math.min(100, event.percent)) + '%';
            } else {
                bar.style.width = '';
                bar.classList.add('indeterminate');
            }
        }
        function setBusy(busy, message) {
            state.busy = busy;
            actions.forEach(id => { const node = el(id); if (node) node.disabled = busy; });
            el('clmm-close').disabled = busy;
            if (busy) {
                clearProgress();
                el('clmm-progress').hidden = false;
                el('clmm-progress-meta').textContent = '진행 중…';
                el('clmm-progress-bar').classList.add('indeterminate');
            }
            if (message) status(message);
            if (!busy) {
                clearProgress();
                const pg = getPagination(state.cards.length, state.page, 200);
                el('clmm-prev').disabled = pg.page <= 1;
                el('clmm-next').disabled = pg.page >= pg.pageCount;
                renderSelection();
            }
        }
        function renderStats() {
            const users = state.cards.filter(isUserAddedSummary).length;
            el('clmm-stats').textContent = `전체 ${state.cards.length.toLocaleString()} | 일반 ${(state.cards.length - users).toLocaleString()} | 추가 ${users.toLocaleString()} | 선택 ${state.selectedIds.size.toLocaleString()}`;
        }
        function renderSelection() {
            const nativeState = getGroupSelectionState(state.cards, state.selectedIds, 'native');
            const nativeBox = el('clmm-select-native');
            nativeBox.checked = nativeState.checked;
            nativeBox.indeterminate = nativeState.indeterminate;
            el('clmm-export-selected').disabled = state.busy || !state.selectedIds.size;
            el('clmm-export-read-log').disabled = state.busy || !getReadLogRuns().length;
            el('clmm-delete-selected').disabled = state.busy || !state.selectedIds.size;
            el('clmm-preview-import').disabled = state.busy || !state.importedCards;
            el('clmm-apply-import').disabled = state.busy || !state.importPlan || !!state.importPlan.blockedReason;
            el('clmm-protect-user').disabled = state.busy || state.importMode === 'backup-restore-experimental';
            renderStats();
        }
        function renderCards() {
            const list = el('clmm-list');
            list.replaceChildren();
            const pg = getPagination(state.cards.length, state.page, 200);
            state.page = pg.page;
            for (const card of state.cards.slice(pg.start, pg.end)) {
                const id = String(getSummaryId(card) || '');
                const row = document.createElement('div');
                row.className = 'clmm-card';
                const check = document.createElement('input');
                check.type = 'checkbox';
                check.checked = state.selectedIds.has(id);
                check.disabled = !id;
                check.addEventListener('change', () => {
                    if (check.checked) state.selectedIds.add(id); else state.selectedIds.delete(id);
                    renderSelection();
                });
                const badge = document.createElement('span');
                const user = isUserAddedSummary(card);
                badge.className = 'clmm-badge' + (user ? ' user' : '');
                badge.textContent = user ? '추가' : '일반';
                const title = document.createElement('div');
                title.className = 'clmm-title';
                title.textContent = card.title || '(제목 없음)';
                const summary = document.createElement('div');
                summary.className = 'clmm-summary';
                summary.textContent = card.summary || '';
                row.append(check, badge, title, summary);
                list.appendChild(row);
            }
            if (!state.cards.length) {
                const empty = document.createElement('div');
                empty.className = 'clmm-card';
                empty.textContent = '장기기억이 없습니다.';
                list.appendChild(empty);
            }
            el('clmm-page').textContent = `${pg.page} / ${pg.pageCount}`;
            el('clmm-prev').disabled = state.busy || pg.page <= 1;
            el('clmm-next').disabled = state.busy || pg.page >= pg.pageCount;
            renderSelection();
        }
        async function refreshCards(message) {
            const chatId = getChatId();
            if (!chatId) throw new Error('현재 URL에서 채팅 ID를 찾을 수 없습니다.');
            setBusy(true, message || '장기기억을 불러오는 중…');
            try {
                const roomChanged = !!state.chatId && !chatIdsMatch(state.chatId, chatId);
                const result = await fetchAllLongTermMemories({ chatId, purpose: '새로고침/초기조회', expectedTotal: chatIdsMatch(state.chatId, chatId) ? (state.cards.length || undefined) : undefined, onProgress: showProgress });
                state.chatId = chatId;
                state.cards = result.cards;
                state.meta = result.meta || {};
                if (roomChanged) {
                    state.selectedIds.clear();
                    invalidateImportData(state);
                    el('clmm-import-text').value = '';
                    el('clmm-import-preview').textContent = '채팅방이 바뀌어 선택·가져오기 상태를 초기화했습니다.';
                } else {
                    const liveIds = new Set(state.cards.map(card => String(getSummaryId(card) || '')).filter(Boolean));
                    state.selectedIds = new Set([...state.selectedIds].filter(id => liveIds.has(id)));
                }
                state.page = 1;
                state.importPlan = null;
                if (!roomChanged && state.importedCards) el('clmm-import-preview').textContent = '서버 목록을 새로고침하여 기존 적용 계획을 폐기했습니다. 미리보기를 다시 실행하세요.';
                renderCards();
                status(`장기기억 ${state.cards.length.toLocaleString()}개를 불러왔습니다. · 요청 limit ${result.readLimit.toLocaleString()} · 최대 응답 ${result.maxPageSize.toLocaleString()}`);
            } finally { setBusy(false); }
        }
        function assertSameChat() {
            if (!chatIdsMatch(state.chatId, getChatId())) throw new Error('작업 중 채팅방이 바뀌어 중단했습니다.');
        }
        async function fetchMutationCards() {
            assertSameChat();
            const result = await fetchAllLongTermMemories({ chatId: state.chatId, purpose: '변경 검증 조회', onProgress: showProgress });
            state.meta = result.meta || {};
            return result.cards;
        }
        function invalidateImportPlanAfterServerChange() {
            state.importPlan = null;
            if (state.importedCards) el('clmm-import-preview').textContent = '서버 상태가 변경되어 기존 적용 계획을 폐기했습니다. 미리보기를 다시 실행하세요.';
        }
        async function exportCards(cards, scope, prefix) {
            const meta = { chatId: state.chatId, chatTitle: document.title, exportedAt: new Date().toISOString() };
            const blob = await buildZipBlob(cards, meta, scope, showProgress);
            const name = `${prefix}_${sanitizeFileName(document.title)}_${formatTimestamp(new Date())}.zip`;
            downloadBlob(blob, name);
        }
        function setImported(cards, source, mode, archiveMeta) {
            showProgress(makeProgressEvent('import-validate', 0, cards.length || 1));
            const screened = screenImportCards(cards, { preserveDuplicates: mode === 'backup-restore-experimental' });
            if (!screened.validCards.length) {
                const detail = screened.rejected.slice(0, 5).map(item => `${item.index}번째${item.title ? ` [${item.title}]` : ''}: ${item.reasons.join(' ')}`).join('\n');
                throw new Error(`사용 가능한 카드가 없습니다.${detail ? `\n${detail}` : ''}`);
            }
            state.importedCards = screened.validCards;
            state.importRejected = screened.rejected;
            state.importMode = mode || 'replace';
            state.archiveMeta = archiveMeta || null;
            showProgress(makeProgressEvent('import-validate', cards.length, cards.length || 1));
            if (state.importMode === 'backup-restore-experimental') state.importPlan = makeBackupRestorePlan(state.importedCards, state.cards, { archiveMeta: state.archiveMeta, currentChatId: state.chatId, userCount: resolveUserCount(state.meta, state.cards) });
            else if (state.importMode === 'backup-selected') state.importPlan = { blockedReason:'선택 ZIP 백업은 전체 복구/전체 교체에 사용할 수 없습니다. 전체 ZIP 백업을 사용해주세요.' };
            else state.importPlan = null;
            const lines = [formatImportScreeningSummary(source, screened)];
            if (state.archiveMeta) {
                lines.push(`백업 원본: ${state.archiveMeta.chatTitle || '(제목 없음)'} · chatId ${state.archiveMeta.chatId || '(없음)'}`);
                lines.push(`백업 시각: ${state.archiveMeta.exportedAt || '(없음)'} · 범위 ${state.archiveMeta.scope || '(없음)'}`);
            }
            if (screened.rejected.length) {
                lines.push('', '제외 카드:');
                for (const item of screened.rejected.slice(0, 20)) lines.push(`${item.index}번째${item.title ? ` [${item.title}]` : ''} · ${item.reasons.join(' ')}`);
                if (screened.rejected.length > 20) lines.push(`외 ${(screened.rejected.length - 20).toLocaleString()}개`);
            }
            if (state.importMode === 'backup-restore-experimental') {
                lines.push('', `전체 백업 복구 계획 · native 이미 존재 ${state.importPlan.keptNative.length.toLocaleString()} / 추가 ${state.importPlan.nativeAdditions.length.toLocaleString()} · 사용자 추가 이미 존재 ${state.importPlan.keptUsers.length.toLocaleString()} / 추가 ${state.importPlan.userAdditions.length.toLocaleString()}`);
                if (state.importPlan.skippedUserAdditions.length) lines.push(`사용자 추가 100개 한도로 제외: ${state.importPlan.skippedUserAdditions.length.toLocaleString()}개`);
                if (state.importPlan.crossChat) lines.push('주의: 백업 원본 채팅과 현재 채팅이 다릅니다. 적용 시 분기방 시험 여부를 별도로 확인합니다.');
                if (state.importPlan.unknownImportedCount) lines.push(`타입 확인 불가 카드 ${state.importPlan.unknownImportedCount.toLocaleString()}개는 복구 대상에서 제외됩니다.`);
                if (state.importPlan.blockedReason) lines.push(`실행 차단: ${state.importPlan.blockedReason}`);
                lines.push('바로 백업 전체 복구(실험)를 실행하거나, 미리보기로 서버 상태를 다시 확인할 수 있습니다.');
            } else if (state.importMode === 'backup-selected') lines.push('', '선택 ZIP 백업은 전체 상태 복구용이 아니므로 적용을 차단했습니다.');
            else lines.push('', '정상 카드로 전체 교체 미리보기를 실행할 수 있습니다.');
            const restore = state.importMode === 'backup-restore-experimental';
            el('clmm-preview-import').textContent = restore ? '백업 복구 미리보기' : '전체 교체 미리보기';
            el('clmm-apply-import').textContent = restore ? '백업 전체 복구(실험)' : '전체 교체 적용';
            el('clmm-import-preview').textContent = lines.join('\n');
            renderSelection();
            return screened;
        }
        async function previewImport() {
            if (!state.importedCards) throw new Error('먼저 외부 AI 결과를 검증하거나 파일을 불러오세요.');
            setBusy(true, '현재 서버 상태를 다시 확인하고 교체 계획을 계산하는 중…');
            try {
                assertSameChat();
                const current = await fetchAllLongTermMemories({ chatId: state.chatId, purpose: '가져오기 미리보기 조회', expectedTotal: state.cards.length || undefined, onProgress: showProgress });
                state.cards = current.cards;
                state.meta = current.meta || {};
                const restoreMode = state.importMode === 'backup-restore-experimental';
                if (state.importMode === 'backup-selected') throw new Error('선택 ZIP 백업은 전체 복구/전체 교체에 사용할 수 없습니다. 전체 ZIP 백업을 사용해주세요.');
                const plan = restoreMode ? makeBackupRestorePlan(state.importedCards, state.cards, { archiveMeta: state.archiveMeta, currentChatId: state.chatId, userCount: resolveUserCount(state.meta, state.cards) }) : makeImportPlan(state.importedCards, state.cards, {
                    includeUserAdded: !el('clmm-protect-user').checked,
                    userCount: resolveUserCount(state.meta, state.cards),
                    isCreatable: typeof state.meta.isCreatable === 'boolean' ? state.meta.isCreatable : undefined
                });
                state.importPlan = plan;
                const lines = restoreMode ? [
                    '전체 백업 복구 실험 모드',
                    `현재 전체: ${state.cards.length.toLocaleString()}`,
                    `가져온 정상 카드: ${state.importedCards.length.toLocaleString()}`,
                    `가져오기 제외: ${state.importRejected.length.toLocaleString()}`,
                    `native 이미 존재: ${plan.keptNative.length.toLocaleString()}`,
                    `native 복구 추가: ${plan.nativeAdditions.length.toLocaleString()}`,
                    `사용자 추가 이미 존재: ${plan.keptUsers.length.toLocaleString()}`,
                    `사용자 추가 복구: ${plan.userAdditions.length.toLocaleString()}`,
                    `사용자 추가 100개 한도로 제외: ${plan.skippedUserAdditions.length.toLocaleString()}`,
                    `현재 카드 보존: ${plan.preservedCards.length.toLocaleString()}`,
                    `예상 최종: ${plan.expectedFinalCount.toLocaleString()}`,
                    `원본 채팅: ${plan.sourceChatId || '(없음)'}${plan.crossChat ? ' · 현재 채팅과 다름' : ''}`,
                    `백업 시각: ${state.archiveMeta && state.archiveMeta.exportedAt || '(없음)'}`
                ] : [
                    `현재 전체: ${state.cards.length.toLocaleString()}`,
                    `가져온 정상 카드: ${state.importedCards.length.toLocaleString()}`,
                    `가져오기 제외: ${state.importRejected.length.toLocaleString()}`,
                    `보호 유지: ${plan.protectedCards.length.toLocaleString()}`,
                    `변경 없음: ${(plan.kept.length + plan.protectedSatisfied.length).toLocaleString()}`,
                    `수정: ${plan.patches.length.toLocaleString()}`,
                    `추가: ${plan.additions.length.toLocaleString()}`,
                    `삭제: ${plan.deletions.length.toLocaleString()}`,
                    `예상 최종: ${plan.expectedFinalCount.toLocaleString()}`,
                    `사용자 추가 카드 보호: ${el('clmm-protect-user').checked ? 'ON' : 'OFF'}`
                ];
                if (!restoreMode && plan.ignoredImportedUserCount) lines.push(`보호 정책으로 가져오기에서 제외한 [추가] 카드: ${plan.ignoredImportedUserCount.toLocaleString()}`);
                if (plan.blockedReason) lines.push(`\n실행 차단: ${plan.blockedReason}`);
                el('clmm-import-preview').textContent = lines.join('\n');
                renderCards();
            } finally { setBusy(false); }
        }

        open.addEventListener('click', async () => {
            overlay.hidden = false;
            const liveChatId = getChatId();
            if (!liveChatId) { status('현재 URL에서 채팅 ID를 찾을 수 없습니다.'); return; }
            if (!chatIdsMatch(state.chatId, liveChatId)) {
                state.chatId = '';
                state.cards = [];
                state.meta = {};
                state.selectedIds.clear();
                state.page = 1;
                invalidateImportData(state);
                el('clmm-import-text').value = '';
                el('clmm-import-preview').textContent = '채팅방이 바뀌어 가져오기 상태를 초기화했습니다.';
            }
            if (!state.cards.length && !state.busy) {
                try { await refreshCards(); } catch (error) { status(error.message); setBusy(false); }
            }
        });
        el('clmm-close').addEventListener('click', () => { if (!state.busy) overlay.hidden = true; });
        overlay.addEventListener('click', event => { if (event.target === overlay && !state.busy) overlay.hidden = true; });
        el('clmm-refresh').addEventListener('click', () => refreshCards().catch(error => status(error.message)));
        el('clmm-export-read-log').addEventListener('click', () => {
            const runs = getReadLogRuns();
            if (!runs.length) { status('저장할 조회 로그가 없습니다.'); return; }
            const blob = new Blob(['\uFEFF' + buildReadLogText(getReadLogRuns())], { type: 'text/plain;charset=utf-8' });
            const name = `Crack_LongTermMemory_READ_LOG_${formatTimestamp(new Date())}.txt`;
            downloadBlob(blob, name);
            status(`조회 로그 ${runs.length.toLocaleString()}회분 TXT 다운로드를 시작했습니다.`);
        });
        el('clmm-select-native').addEventListener('change', event => { state.selectedIds = toggleGroupSelection(state.cards, state.selectedIds, 'native', event.target.checked); renderCards(); });
        el('clmm-prev').addEventListener('click', () => { state.page--; renderCards(); });
        el('clmm-next').addEventListener('click', () => { state.page++; renderCards(); });
        el('clmm-export-all').addEventListener('click', async () => {
            setBusy(true, `현재 불러온 전체 ${state.cards.length.toLocaleString()}개로 ZIP을 만드는 중…`);
            try {
                assertSameChat();
                const source = await resolveExportSource('all', state.cards, state.selectedIds);
                await exportCards(source.cards, 'all', 'Crack_LongTermMemory_ALL');
                status(`현재 목록 기준 전체 ${source.cards.length.toLocaleString()}개 ZIP 다운로드를 시작했습니다.`);
            } catch (error) { status(error.message); } finally { setBusy(false); }
        });
        el('clmm-export-selected').addEventListener('click', async () => {
            setBusy(true, '선택 장기기억을 서버에서 다시 확인하는 중…');
            try {
                assertSameChat();
                const source = await resolveExportSource('selected', state.cards, state.selectedIds, () => fetchAllLongTermMemories({ chatId: state.chatId, purpose: '선택 ZIP 검증 조회', expectedTotal: state.cards.length || undefined, onProgress: showProgress }));
                state.cards = source.fresh.cards;
                state.meta = source.fresh.meta || {};
                await exportCards(source.cards, 'selected', 'Crack_LongTermMemory_SELECTED');
                renderCards();
                status(`선택 ${source.cards.length.toLocaleString()}개 ZIP 다운로드를 시작했습니다.`);
            } catch (error) { status(error.message); } finally { setBusy(false); }
        });
        el('clmm-import-file-btn').addEventListener('click', () => el('clmm-import-file').click());
        el('clmm-import-file').addEventListener('change', async event => {
            const file = event.target.files && event.target.files[0];
            if (!file) return;
            setBusy(true, '가져오기 파일을 읽는 중…');
            try {
                const bundle = await readArchiveBundle(file, undefined, showProgress);
                const mode = getImportModeForArchive(bundle);
                const screened = setImported(bundle.cards, file.name, mode, bundle.meta);
                status(formatImportScreeningSummary(file.name, screened));
            } catch (error) {
                invalidateImportData(state);
                const message = String(error && error.message || error);
                el('clmm-import-preview').textContent = message;
                status(`가져오기 실패 · ${message.split('\n')[0]}`);
            } finally { event.target.value = ''; setBusy(false); }
        });
        el('clmm-validate-text').addEventListener('click', () => {
            try {
                const screened = setImported(parseMemoryText(el('clmm-import-text').value), '붙여넣기', 'replace');
                status(formatImportScreeningSummary('붙여넣기', screened));
            } catch (error) {
                invalidateImportData(state);
                const message = String(error && error.message || error);
                el('clmm-import-preview').textContent = message;
                status(`붙여넣기 실패 · ${message.split('\n')[0]}`);
                renderSelection();
            }
        });
        el('clmm-import-text').addEventListener('input', () => {
            invalidateImportData(state);
            el('clmm-import-preview').textContent = '붙여넣기 내용이 변경되었습니다. 다시 검증하세요.';
            renderSelection();
        });
        el('clmm-protect-user').addEventListener('change', () => {
            if (state.importMode === 'backup-restore-experimental') { renderSelection(); return; }
            state.importPlan = null;
            el('clmm-import-preview').textContent = state.importedCards ? '보호 정책이 바뀌었습니다. 미리보기를 다시 실행하세요.' : '가져온 데이터 없음';
            renderSelection();
        });
        el('clmm-preview-import').addEventListener('click', () => previewImport().catch(error => { status(error.message); setBusy(false); }));
        el('clmm-apply-import').addEventListener('click', async () => {
            if (!state.importPlan || state.importPlan.blockedReason) return;
            const restoreMode = state.importMode === 'backup-restore-experimental';
            if (restoreMode) {
                let allowCrossChat = false;
                if (state.importPlan.crossChat) {
                    allowCrossChat = window.confirm(`백업 원본 채팅과 현재 채팅이 다릅니다.
원본: ${state.importPlan.sourceChatId}
현재: ${state.importPlan.targetChatId}

분기방 시험으로 전체 복구를 계속하시겠습니까?`);
                    if (!allowCrossChat) { status('다른 채팅방 백업 복구를 취소했습니다.'); return; }
                }
                if (!window.confirm(`전체 백업 복구 실험을 실행합니다.
현재 카드는 수정/삭제하지 않고 보존합니다.
native 추가 ${state.importPlan.nativeAdditions.length.toLocaleString()}개 / 사용자 추가 복구 ${state.importPlan.userAdditions.length.toLocaleString()}개${state.importPlan.skippedUserAdditions.length ? ` / 사용자 추가 한도 제외 ${state.importPlan.skippedUserAdditions.length.toLocaleString()}개` : ''}
계속하시겠습니까?`)) return;
                setBusy(true, '전체 백업 복구 실험을 시작합니다…');
                const fetchRestoreCards = fetchMutationCards;
                try {
                    const result = await applyBackupRestorePlan(state.importPlan, {
                        fetchCards: fetchRestoreCards,
                        addNative: card => addNativeMemoryCard(card, { chatId: state.chatId }),
                        addUser: card => addMemoryCard(card, { chatId: state.chatId }),
                        deleteProbe: item => deleteMemoryCard(item, { chatId: state.chatId }),
                        assertReady: assertSameChat,
                        allowCrossChat,
                        onProgress: showProgress
                    });
                    state.cards = result.after;
                    state.selectedIds.clear();
                    state.importPlan = makeBackupRestorePlan(state.importedCards, state.cards, { archiveMeta: state.archiveMeta, currentChatId: state.chatId, userCount: resolveUserCount(state.meta, state.cards) });
                    renderCards();
                    status(`전체 백업 복구 및 서버 검증 완료 · native ${result.addedNative.toLocaleString()} / 사용자 추가 ${result.addedUser.toLocaleString()} 복구${state.importPlan.skippedUserAdditions.length ? ` · 사용자 추가 한도 제외 ${state.importPlan.skippedUserAdditions.length.toLocaleString()}` : ''} · 현재 ${result.after.length.toLocaleString()}개`);
                } catch (error) {
                    let recovery = '';
                    try {
                        const current = await fetchRestoreCards();
                        state.cards = current;
                        state.importPlan = makeBackupRestorePlan(state.importedCards, state.cards, { archiveMeta: state.archiveMeta, currentChatId: state.chatId, userCount: resolveUserCount(state.meta, state.cards) });
                        recovery = ` · 현재 ${current.length.toLocaleString()}개 · 남은 native ${state.importPlan.nativeAdditions.length.toLocaleString()} / 사용자 추가 ${state.importPlan.userAdditions.length.toLocaleString()}${state.importPlan.skippedUserAdditions.length ? ` · 사용자 추가 한도 제외 ${state.importPlan.skippedUserAdditions.length.toLocaleString()}` : ''}`;
                        renderCards();
                    } catch (refreshError) { recovery = ` · 실패 후 서버 상태 재조회도 실패: ${refreshError.message}`; }
                    status(`전체 백업 복구 중단 · ${error.message}${recovery}`);
                } finally { setBusy(false); }
                return;
            }
            if (!window.confirm(`장기기억을 실제로 교체합니다.
수정 ${state.importPlan.patches.length} / 추가 ${state.importPlan.additions.length} / 삭제 ${state.importPlan.deletions.length}
계속하시겠습니까?`)) return;
            setBusy(true, '전체 교체를 시작합니다…');
            try {
                const result = await applyImportPlan(state.importPlan, {
                    fetchCards: fetchMutationCards,
                    patch: entry => updateMemoryCard(entry.target, entry.card, { chatId: state.chatId }),
                    add: card => addMemoryCard(card, { chatId: state.chatId }),
                    delete: item => deleteMemoryCard(item, { chatId: state.chatId }),
                    assertReady: assertSameChat,
                    onProgress: showProgress,
                    onDeleteConcurrency: event => status(`DELETE 동시성 임시 탐색 · ${event.from}개 → ${event.to}개 하향 · 재시도 ${event.failed.toLocaleString()}개${event.reason === 'rate-limit-or-failure' ? ' · 429/실패 관측' : ''}`),
                    onDeleteRateLimit: event => status(`DELETE 429 · 서버 Retry-After ${event.retryAfterMs}ms 대기 후 동시 ${event.concurrency} 재시도 · ${event.failed.toLocaleString()}개`)
                });
                state.cards = result.after;
                state.selectedIds.clear();
                state.importPlan = null;
                renderCards();
                status(`전체 교체 및 서버 검증 완료 · 수정 ${result.patched} / 추가 ${result.added} / 삭제 ${result.deleted}${result.deleteConcurrency ? ` · DELETE 최종 동시 ${result.deleteConcurrency}개` : ''}${result.deleteRateLimited ? ' · 429 관측' : ''}${result.deleteConcurrencyCertain ? '' : ' · 안전선 미확정'}`);
            } catch (error) {
                status(`전체 교체 중단 · ${error.message}`);
                try {
                    state.cards = await fetchMutationCards();
                    const liveIds = new Set(state.cards.map(card => String(getSummaryId(card) || '')).filter(Boolean));
                    state.selectedIds = new Set([...state.selectedIds].filter(id => liveIds.has(id)));
                    state.importPlan = makeImportPlan(state.importedCards, state.cards, {
                        includeUserAdded: !el('clmm-protect-user').checked,
                        userCount: resolveUserCount(state.meta, state.cards),
                        isCreatable: typeof state.meta.isCreatable === 'boolean' ? state.meta.isCreatable : undefined
                    });
                    el('clmm-import-preview').textContent = `전체 교체가 중단되어 현재 서버 기준으로 계획을 다시 계산했습니다.
남은 수정 ${state.importPlan.patches.length.toLocaleString()} / 추가 ${state.importPlan.additions.length.toLocaleString()} / 삭제 ${state.importPlan.deletions.length.toLocaleString()}${state.importPlan.blockedReason ? `
실행 차단: ${state.importPlan.blockedReason}` : ''}`;
                    renderCards();
                    status(`전체 교체 중단 · ${error.message} · 현재 ${state.cards.length.toLocaleString()}개 · 남은 수정 ${state.importPlan.patches.length.toLocaleString()} / 추가 ${state.importPlan.additions.length.toLocaleString()} / 삭제 ${state.importPlan.deletions.length.toLocaleString()}`);
                } catch (refreshError) { status(`전체 교체 중단 · ${error.message} · 실패 후 서버 상태 재조회도 실패: ${refreshError.message}`); }
            }
            finally { setBusy(false); }
        });
        el('clmm-delete-selected').addEventListener('click', async () => {
            const targets = state.cards.filter(card => state.selectedIds.has(String(getSummaryId(card) || '')));
            if (!targets.length) return;
            const backupFirst = await deleteBackupChoice(el('clmm-modal'), '장기기억 삭제', `선택한 장기기억 ${targets.length.toLocaleString()}개를 삭제합니다. 삭제 전에 현재 장기기억 전체 ZIP 백업을 받으시겠습니까?`);
            if (backupFirst === null) { status('장기기억 삭제를 취소했습니다.'); return; }
            setBusy(true, backupFirst ? '삭제 전 전체 ZIP 백업을 만드는 중…' : '장기기억 삭제 준비 중…');
            try {
                if (backupFirst) await exportCards(state.cards, 'all', 'Crack_LongTermMemory_BEFORE_DELETE');
                status(backupFirst ? '전체 ZIP 백업 다운로드를 시작했습니다. 장기기억 삭제를 시작합니다.' : '백업 없이 장기기억 삭제를 시작합니다.');
                const plan = buildDeletePlan(targets, state.cards);
                const result = await applyDeletePlan(plan, {
                    fetchCards: fetchMutationCards,
                    delete: item => deleteMemoryCard(item, { chatId: state.chatId }),
                    assertReady: assertSameChat,
                    onProgress: showProgress,
                    onDeleteConcurrency: event => status(`DELETE 동시성 임시 탐색 · ${event.from}개 → ${event.to}개 하향 · 재시도 ${event.failed.toLocaleString()}개${event.reason === 'rate-limit-or-failure' ? ' · 429/실패 관측' : ''}`),
                    onDeleteRateLimit: event => status(`DELETE 429 · 서버 Retry-After ${event.retryAfterMs}ms 대기 후 동시 ${event.concurrency} 재시도 · ${event.failed.toLocaleString()}개`)
                });
                state.cards = result.after; state.selectedIds.clear(); invalidateImportPlanAfterServerChange(); renderCards();
                status(`장기기억 삭제 및 서버 검증 완료 · ${result.deleted.toLocaleString()}개 삭제 · 최종 동시 ${result.deleteConcurrency}개${result.deleteRateLimited ? ' · 429 관측' : ''}${result.deleteConcurrencyCertain ? '' : ' · 안전선 미확정'}`);
            } catch (error) {
                status(`장기기억 삭제 중단 · ${error.message}`);
                try {
                    state.cards = await fetchMutationCards();
                    const liveIds = new Set(state.cards.map(card => String(getSummaryId(card) || '')).filter(Boolean));
                    state.selectedIds = new Set([...state.selectedIds].filter(id => liveIds.has(id)));
                    invalidateImportPlanAfterServerChange();
                    renderCards();
                    status(`장기기억 삭제 중단 · ${error.message} · 현재 ${state.cards.length.toLocaleString()}개 · 남은 선택 ${state.selectedIds.size.toLocaleString()}개`);
                } catch (refreshError) { status(`장기기억 삭제 중단 · ${error.message} · 실패 후 서버 상태 재조회도 실패: ${refreshError.message}`); }
            }
            finally { setBusy(false); }
        });
        el('clmm-delete-all').addEventListener('click', async () => {
            const targets = [...state.cards];
            if (!targets.length) { status('삭제할 장기기억이 없습니다.'); return; }
            const backupFirst = await deleteBackupChoice(el('clmm-modal'), '장기기억 전체 삭제', `사용자 추가 카드를 포함해 현재 장기기억 ${targets.length.toLocaleString()}개를 전부 삭제합니다. 삭제 전에 현재 장기기억 전체 ZIP 백업을 받으시겠습니까?\n\n전체 복구 기능은 아직 실험 단계입니다. 원본 백업을 보관한 상태에서 진행하세요.`);
            if (backupFirst === null) { status('장기기억 전체 삭제를 취소했습니다.'); return; }
            setBusy(true, backupFirst ? '전체 삭제 전 ZIP 백업을 만드는 중…' : '장기기억 전체 삭제 준비 중…');
            try {
                if (backupFirst) await exportCards(state.cards, 'all', 'Crack_LongTermMemory_BEFORE_DELETE');
                status(backupFirst ? '전체 ZIP 백업 다운로드를 시작했습니다. 장기기억 전체 삭제를 시작합니다.' : '백업 없이 장기기억 전체 삭제를 시작합니다.');
                const plan = buildDeletePlan(targets, state.cards);
                const result = await applyDeletePlan(plan, {
                    fetchCards: fetchMutationCards,
                    delete: item => deleteMemoryCard(item, { chatId: state.chatId }),
                    assertReady: assertSameChat,
                    onProgress: showProgress,
                    onDeleteConcurrency: event => status(`DELETE 동시성 임시 탐색 · ${event.from}개 → ${event.to}개 하향 · 재시도 ${event.failed.toLocaleString()}개${event.reason === 'rate-limit-or-failure' ? ' · 429/실패 관측' : ''}`),
                    onDeleteRateLimit: event => status(`DELETE 429 · 서버 Retry-After ${event.retryAfterMs}ms 대기 후 동시 ${event.concurrency} 재시도 · ${event.failed.toLocaleString()}개`),
                    requireEmpty: true
                });
                state.cards = result.after; state.selectedIds.clear(); invalidateImportPlanAfterServerChange(); renderCards();
                status(`장기기억 전체 삭제 및 서버 검증 완료 · ${result.deleted.toLocaleString()}개 삭제 · 최종 동시 ${result.deleteConcurrency}개${result.deleteRateLimited ? ' · 429 관측' : ''}${result.deleteConcurrencyCertain ? '' : ' · 안전선 미확정'} · 현재 0개`);
            } catch (error) {
                status(`장기기억 전체 삭제 중단 · ${error.message}`);
                try {
                    state.cards = await fetchMutationCards();
                    state.selectedIds.clear();
                    invalidateImportPlanAfterServerChange();
                    renderCards();
                    status(`장기기억 전체 삭제 중단 · ${error.message} · 현재 ${state.cards.length.toLocaleString()}개`);
                } catch (refreshError) { status(`장기기억 전체 삭제 중단 · ${error.message} · 실패 후 서버 상태 재조회도 실패: ${refreshError.message}`); }
            }
            finally { setBusy(false); }
        });

    }

    const exported = { API_BASE, CHUNK_SIZE, getSummaryId, isUserAddedSummary, isNativeSummary, chunkItems, toggleGroupSelection, getGroupSelectionState, getPagination, cardSignature, parseMemoryText, normalizeArchiveJson, validateCards, screenImportCards, formatImportScreeningSummary, makeImportPlan, makeBackupRestorePlan, partitionMutationPlan, verifyPlanResult, verifyBackupRestoreResult, applyImportPlan, applyBackupRestorePlan, buildDeletePlan, applyDeletePlan, deleteInWaves, buildArchiveText, buildArchivePayload, buildArchiveFiles, buildStoreZipBlob, buildZipBlob, readArchiveFile, readArchiveBundle, buildArchiveManifest, mergeArchiveParts, getChatId, chatIdsMatch, getToken, apiCall, fetchAllLongTermMemories, updateMemoryCard, addMemoryCard, addNativeMemoryCard, deleteMemoryCard, snapshotCards, resolveUserCount, invalidateImportData, selectFreshCardsByIds, resolveExportSource, formatProgressText, isZipFile, normalizeArchiveMeta, getImportModeForArchive, parseRetryAfterMs, getReadLogRuns, clearReadLogRuns, buildReadLogText };
    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
    if (typeof document !== 'undefined' && typeof window !== 'undefined') initUi();
})();