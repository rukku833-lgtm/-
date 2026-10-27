
'use strict';

// ==========================================
// Web Audio API
// ==========================================

const AudioContextClass =
    window.AudioContext || window.webkitAudioContext;

let audioContext = null;

// ==========================================
// 設定・定数
// ==========================================

const STORAGE_KEY = 'web_metronome_settings_v10';

const DEFAULT_TEMPO = 100;
const MIN_TEMPO = 30;
const MAX_TEMPO = 300;
const DRAG_SENSITIVITY = 5;

const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD_TIME = 0.1;

const DEFAULT_SEQUENCE = [
    { beats: 4, unit: 4, sub: [1, 1, 1, 1] }
];

const SUBDIVISION_TYPES = [
    { value: 1, label: '4分' },
    { value: 2, label: '8分' },
    { value: 3, label: '3連' },
    { value: 4, label: '16分' },
    { value: 5, label: '5連' },
    { value: 6, label: '6連' },
    { value: 7, label: '7連' },
    { value: 8, label: '8連' }
];

const TIME_SIGNATURE_OPTIONS = [
    { label: '4/4 拍子', beats: 4, unit: 4 },
    { label: '3/4 拍子', beats: 3, unit: 4 },
    { label: '2/4 拍子', beats: 2, unit: 4 },
    { label: '6/8 拍子', beats: 6, unit: 8 },
    { label: '3/8 拍子', beats: 3, unit: 8 },
    { label: '5/4 拍子', beats: 5, unit: 4 },
    { label: '7/8 拍子', beats: 7, unit: 8 }
];

// ==========================================
// 状態管理
// ==========================================

let tempo = DEFAULT_TEMPO;
let sequence = structuredClone(DEFAULT_SEQUENCE);

// 編集対象の小節
let currentMeasureIndex = 0;

// 再生専用の位置管理
let scheduleMeasureIndex = 0;
let scheduleNoteIndex = 0;

let isPlaying = false;
let nextNoteTime = 0;
let timerID = null;

let lastRenderedMeasureIndex = -1;

// 小節ごとのミュート状態
let beatMutedByMeasure = [];

// BPMドラッグ操作状態
let isDraggingBpm = false;
let startX = 0;
let startTempo = DEFAULT_TEMPO;

// ==========================================
// DOM要素
// ==========================================

const bpmDisplay = document.getElementById('bpmDisplay');

const minusBtn = document.getElementById('minusBtn');
const plusBtn = document.getElementById('plusBtn');
const startStopBtn = document.getElementById('startStopBtn');

const measureList = document.getElementById('measureList');
const addMeasureBtn = document.getElementById('addMeasureBtn');
const resetSeqBtn = document.getElementById('resetSeqBtn');

const globalSubdivSelect =
    document.getElementById('globalSubdivSelect');

const beatContainer = document.getElementById('beatContainer');
const currentMeasureDisplay =
    document.getElementById('currentMeasureDisplay');

// ==========================================
// 初期化
// ==========================================

function init() {
    loadSettings();
    normalizeSequence();
    initializeMuteStates();

    updateTempoUI();
    renderMeasureSequenceUI();
    renderBeatCircles(sequence[currentMeasureIndex]);

    registerEvents();
}

function normalizeSequence() {
    if (!Array.isArray(sequence) || sequence.length === 0) {
        sequence = structuredClone(DEFAULT_SEQUENCE);
    }

    sequence = sequence.map((item) => {
        const rawBeats = Number(item.beats);
        const rawUnit = Number(item.unit);

        const beats =
            Number.isInteger(rawBeats) &&
            rawBeats >= 1 &&
            rawBeats <= 32
                ? rawBeats
                : 4;

        const unit = [2, 4, 8, 16].includes(rawUnit)
            ? rawUnit
            : 4;

        const sub = Array.isArray(item.sub)
            ? Array.from({ length: beats }, (_, index) => {
                const value = Number(item.sub[index]);

                return SUBDIVISION_TYPES.some(
                    option => option.value === value
                )
                    ? value
                    : 1;
            })
            : new Array(beats).fill(1);

        return { beats, unit, sub };
    });

    const numericTempo = Number(tempo);
    tempo = Number.isFinite(numericTempo)
        ? clampTempo(Math.round(numericTempo))
        : DEFAULT_TEMPO;

    currentMeasureIndex = Math.max(
        0,
        Math.min(currentMeasureIndex, sequence.length - 1)
    );
}

function initializeMuteStates() {
    beatMutedByMeasure = sequence.map((measure) =>
        new Array(measure.beats).fill(false)
    );
}

function clampTempo(value) {
    return Math.max(
        MIN_TEMPO,
        Math.min(MAX_TEMPO, value)
    );
}

function updateTempoUI() {
    if (bpmDisplay) {
        bpmDisplay.textContent = tempo;
    }
}

// ==========================================
// 設定の保存・読み込み
// ==========================================

function saveSettings() {
    try {
        localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
                tempo,
                sequence
            })
        );
    } catch (error) {
        console.error('設定の保存に失敗しました:', error);
    }
}

function loadSettings() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);

        if (!saved) return;

        const data = JSON.parse(saved);

        if (Number.isFinite(Number(data.tempo))) {
            tempo = clampTempo(Math.round(Number(data.tempo)));
        }

        if (
            Array.isArray(data.sequence) &&
            data.sequence.length > 0
        ) {
            sequence = data.sequence;
        }
    } catch (error) {
        console.error('設定の読み込みに失敗しました:', error);

        tempo = DEFAULT_TEMPO;
        sequence = structuredClone(DEFAULT_SEQUENCE);
    }
}

function resetSettings() {
    const confirmed = confirm(
        '小節パターンとテンポを初期状態に戻しますか？'
    );

    if (!confirmed) return;

    stopPlayback();

    tempo = DEFAULT_TEMPO;
    sequence = structuredClone(DEFAULT_SEQUENCE);

    currentMeasureIndex = 0;
    scheduleMeasureIndex = 0;
    scheduleNoteIndex = 0;
    lastRenderedMeasureIndex = -1;

    initializeMuteStates();

    updateTempoUI();
    renderMeasureSequenceUI();
    renderBeatCircles(sequence[0]);

    saveSettings();
}

// ==========================================
// BPM 左右ドラッグ・ボタン制御
// ==========================================

function setTempo(newTempo) {
    const value = Number(newTempo);

    if (!Number.isFinite(value)) return;

    tempo = clampTempo(Math.round(value));
    updateTempoUI();
    saveSettings();
}

function onDragStart(clientX) {
    isDraggingBpm = true;
    startX = clientX;
    startTempo = tempo;

    if (bpmDisplay) {
        bpmDisplay.classList.add('dragging');
    }
}

function onDragMove(clientX) {
    if (!isDraggingBpm) return;

    const deltaX = clientX - startX;
    const tempoChange = Math.round(deltaX / DRAG_SENSITIVITY);

    setTempo(startTempo + tempoChange);
}

function onDragEnd() {
    if (!isDraggingBpm) return;

    isDraggingBpm = false;

    if (bpmDisplay) {
        bpmDisplay.classList.remove('dragging');
    }
}

function registerBpmEvents() {
    if (bpmDisplay) {
        bpmDisplay.addEventListener('pointerdown', (event) => {
            if (event.button !== undefined && event.button !== 0) {
                return;
            }

            bpmDisplay.setPointerCapture(event.pointerId);
            onDragStart(event.clientX);
        });

        bpmDisplay.addEventListener('pointermove', (event) => {
            if (isDraggingBpm) {
                onDragMove(event.clientX);
            }
        });

        const handlePointerEnd = (event) => {
            if (!isDraggingBpm) return;

            try {
                if (bpmDisplay.hasPointerCapture(event.pointerId)) {
                    bpmDisplay.releasePointerCapture(event.pointerId);
                }
            } catch (error) {
                // ポインターの解放に失敗してもドラッグ終了を優先する
            }

            onDragEnd();
        };

        bpmDisplay.addEventListener('pointerup', handlePointerEnd);
        bpmDisplay.addEventListener('pointercancel', handlePointerEnd);
        bpmDisplay.addEventListener(
            'lostpointercapture',
            handlePointerEnd
        );

        bpmDisplay.addEventListener('wheel', (event) => {
            event.preventDefault();

            const delta = event.deltaY !== 0
                ? -event.deltaY
                : event.deltaX;

            if (delta > 0) {
                setTempo(tempo + 1);
            } else if (delta < 0) {
                setTempo(tempo - 1);
            }
        }, { passive: false });
    }

    if (minusBtn) {
        minusBtn.addEventListener('click', () => {
            setTempo(tempo - 1);
        });
    }

    if (plusBtn) {
        plusBtn.addEventListener('click', () => {
            setTempo(tempo + 1);
        });
    }
}

// ==========================================
// 小節の選択
// ==========================================

function selectMeasure(index) {
    if (index < 0 || index >= sequence.length) return;

    currentMeasureIndex = index;

    renderMeasureSequenceUI();
    renderBeatCircles(sequence[currentMeasureIndex]);
    updateStatusDisplay();
    saveSettings();
}

// ==========================================
// 小節シーケンスの描画・操作
// ==========================================

function renderMeasureSequenceUI() {
    if (!measureList) return;

    measureList.innerHTML = '';

    sequence.forEach((measure, index) => {
        const div = document.createElement('div');
        div.className = 'measure-item';
        div.style.cursor = 'pointer';
        div.dataset.measureIndex = index;

        if (index === currentMeasureIndex) {
            div.classList.add('active-measure');
        }

        // 小節の枠をクリックすると編集対象を切り替える。
        // 拍子選択や削除ボタンを操作した場合は選択イベントを重ねない。
        div.addEventListener('click', (event) => {
            if (event.target.closest('select, button')) return;
            selectMeasure(index);
        });

        const label = document.createElement('span');
        label.className = 'measure-label';
        label.textContent = `小節 ${index + 1}:`;

        const select = document.createElement('select');
        select.className = 'measure-select';

        TIME_SIGNATURE_OPTIONS.forEach((optionData) => {
            const option = document.createElement('option');

            option.value =
                `${optionData.beats}/${optionData.unit}`;
            option.textContent = optionData.label;

            option.selected =
                optionData.beats === measure.beats &&
                optionData.unit === measure.unit;

            select.appendChild(option);
        });

        select.addEventListener('change', (event) => {
            const [beats, unit] = event.target.value
                .split('/')
                .map(Number);

            const oldMuteState = beatMutedByMeasure[index] || [];

            sequence[index] = {
                beats,
                unit,
                sub: new Array(beats).fill(1)
            };

            beatMutedByMeasure[index] = Array.from(
                { length: beats },
                (_, beatIndex) =>
                    oldMuteState[beatIndex] ?? false
            );

            // 再生中に拍子を変えた場合も、
            // 再生カーソルが存在しない拍を指さないように補正する。
            if (
                scheduleMeasureIndex === index &&
                scheduleNoteIndex >= beats
            ) {
                scheduleNoteIndex = 0;
            }

            if (index === currentMeasureIndex) {
                renderBeatCircles(sequence[index]);
            }

            renderMeasureSequenceUI();
            saveSettings();
        });

        const deleteButton = document.createElement('button');
        deleteButton.className = 'btn-delete-measure';
        deleteButton.type = 'button';
        deleteButton.textContent = '✕';
        deleteButton.title = '小節を削除';

        deleteButton.addEventListener('click', (event) => {
            event.stopPropagation();

            if (sequence.length <= 1) {
                alert('最低1つの小節が必要です');
                return;
            }

            const deletedIndex = index;

            sequence.splice(deletedIndex, 1);
            beatMutedByMeasure.splice(deletedIndex, 1);

            if (currentMeasureIndex > deletedIndex) {
                currentMeasureIndex--;
            } else if (currentMeasureIndex === deletedIndex) {
                currentMeasureIndex = Math.min(
                    deletedIndex,
                    sequence.length - 1
                );
            }

            // 再生カーソルも削除位置に合わせて調整する。
            if (scheduleMeasureIndex > deletedIndex) {
                scheduleMeasureIndex--;
            } else if (scheduleMeasureIndex === deletedIndex) {
                scheduleMeasureIndex %= sequence.length;
                scheduleNoteIndex = 0;
            }

            scheduleMeasureIndex =
                Math.min(scheduleMeasureIndex, sequence.length - 1);

            scheduleNoteIndex = Math.min(
                scheduleNoteIndex,
                sequence[scheduleMeasureIndex].beats - 1
            );

            lastRenderedMeasureIndex = -1;

            renderMeasureSequenceUI();
            renderBeatCircles(sequence[currentMeasureIndex]);
            saveSettings();
        });

        div.append(label, select, deleteButton);
        measureList.appendChild(div);
    });

    updateStatusDisplay();
}

// ==========================================
// 「全拍一括音符」の表示同期
// ==========================================

function syncGlobalSubdivSelect() {
    if (!globalSubdivSelect) return;

    const measure = sequence[currentMeasureIndex];

    if (!measure || !Array.isArray(measure.sub)) return;

    const firstSub = measure.sub[0] ?? 1;

    const allSame = measure.sub.every(
        value => value === firstSub
    );

    // 全拍が同じならその値を表示。
    // 混在している場合は空欄にする。
    globalSubdivSelect.value = allSame
        ? String(firstSub)
        : '';

    // HTML側に空欄の選択肢がない場合でも表示を空にできるようにする。
    if (!allSame && globalSubdivSelect.value !== '') {
        globalSubdivSelect.selectedIndex = -1;
    }
}

// ==========================================
// 拍ボタン・音符分割の描画
// ==========================================

function renderBeatCircles(measureData) {
    if (!beatContainer || !measureData) return;

    beatContainer.innerHTML = '';

    const measureIndex = sequence.indexOf(measureData);

    if (measureIndex < 0) return;

    const muteStates = beatMutedByMeasure[measureIndex];

    for (let i = 0; i < measureData.beats; i++) {
        const wrapper = document.createElement('div');
        wrapper.className = 'beat-item';

        const button = document.createElement('button');
        button.className = 'beat-circle';
        button.dataset.beat = i;
        button.type = 'button';

        if (muteStates[i]) {
            button.classList.add('muted');
        }

        const number = document.createElement('span');
        number.className = 'beat-num';
        number.textContent = i + 1;

        button.appendChild(number);

        button.addEventListener('click', () => {
            muteStates[i] = !muteStates[i];
            button.classList.toggle('muted', muteStates[i]);
            saveSettings();
        });

        const select = document.createElement('select');
        select.className = 'beat-subdiv-select';

        SUBDIVISION_TYPES.forEach((subdivision) => {
            const option = document.createElement('option');

            option.value = String(subdivision.value);
            option.textContent = subdivision.label;
            option.selected =
                measureData.sub[i] === subdivision.value;

            select.appendChild(option);
        });

        select.addEventListener('change', (event) => {
            measureData.sub[i] = Number(event.target.value);

            syncGlobalSubdivSelect();
            saveSettings();
        });

        wrapper.append(button, select);
        beatContainer.appendChild(wrapper);
    }

    syncGlobalSubdivSelect();
    updateStatusDisplay();
}

function updateStatusDisplay() {
    if (!currentMeasureDisplay || !measureList) return;

    const measure = sequence[currentMeasureIndex];

    if (!measure) return;

    currentMeasureDisplay.textContent =
        `第 ${currentMeasureIndex + 1} / ${sequence.length} 小節 ` +
        `(${measure.beats}/${measure.unit}拍子)`;

    const items = measureList.querySelectorAll('.measure-item');

    items.forEach((item, index) => {
        item.classList.toggle(
            'active-measure',
            index === currentMeasureIndex
        );
    });
}

function updateVisualBeat(measureIndex, beatNumber) {
    if (!isPlaying || !sequence[measureIndex]) return;

    // 再生中は編集対象の小節を勝手に変更しない。
    // 再生位置の表示と編集対象の状態を分離する。
    const measureChanged =
        lastRenderedMeasureIndex !== measureIndex;

    if (measureChanged) {
        lastRenderedMeasureIndex = measureIndex;

        const circles = beatContainer
            ? beatContainer.querySelectorAll('.beat-circle')
            : [];

        circles.forEach((circle) => {
            circle.classList.remove('active');
        });
    }

    // 再生中の小節が編集中の小節と同じときだけ、
    // 拍ボタンの点灯を更新する。
    if (measureIndex === currentMeasureIndex && beatContainer) {
        const circles = beatContainer.querySelectorAll('.beat-circle');

        circles.forEach((circle, index) => {
            circle.classList.toggle('active', index === beatNumber);
        });
    }
}

// ==========================================
// 音声スケジューラー
// ==========================================

function getSecondsPerBeat(measure) {
    return (60 / tempo) * (4 / measure.unit);
}

function playClick(time, frequency, volume, duration) {
    if (!audioContext) return;

    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, time);

    gain.gain.setValueAtTime(volume, time);
    gain.gain.exponentialRampToValueAtTime(
        0.001,
        time + duration
    );

    oscillator.connect(gain);
    gain.connect(audioContext.destination);

    oscillator.start(time);
    oscillator.stop(time + duration + 0.005);
}

function scheduleNote(measureIndex, beatNumber, time) {
    const measure = sequence[measureIndex];

    if (!measure) return;

    const subCount = measure.sub[beatNumber] || 1;

    const secondsPerBeat = getSecondsPerBeat(measure);
    const subInterval = secondsPerBeat / subCount;

    const delay = Math.max(
        0,
        (time - audioContext.currentTime) * 1000
    );

    setTimeout(() => {
        if (isPlaying) {
            updateVisualBeat(measureIndex, beatNumber);
        }
    }, delay);

    const isMuted =
        beatMutedByMeasure[measureIndex]?.[beatNumber] ?? false;

    if (isMuted) return;

    for (let subdivision = 0; subdivision < subCount; subdivision++) {
        const noteTime = time + subdivision * subInterval;

        if (subdivision === 0) {
            const isFirstBeat = beatNumber === 0;

            playClick(
                noteTime,
                isFirstBeat ? 1200 : 800,
                0.7,
                0.025
            );
        } else {
            playClick(
                noteTime,
                600,
                0.3,
                0.015
            );
        }
    }
}

function scheduler() {
    if (!isPlaying || !audioContext) return;

    while (
        nextNoteTime <
        audioContext.currentTime + SCHEDULE_AHEAD_TIME
    ) {
        // スケジューラーは専用カーソルを使用する。
        const measureIndex = scheduleMeasureIndex;
        const noteNumber = scheduleNoteIndex;
        const measure = sequence[measureIndex];

        if (!measure) {
            scheduleMeasureIndex = 0;
            scheduleNoteIndex = 0;
            break;
        }

        scheduleNote(
            measureIndex,
            noteNumber,
            nextNoteTime
        );

        nextNoteTime += getSecondsPerBeat(measure);

        scheduleNoteIndex++;

        if (scheduleNoteIndex >= measure.beats) {
            scheduleNoteIndex = 0;
            scheduleMeasureIndex =
                (scheduleMeasureIndex + 1) % sequence.length;
        }
    }
}

// ==========================================
// 再生・停止
// ==========================================

async function startStop() {
    if (!AudioContextClass) {
        alert('このブラウザはWeb Audio APIに対応していません。');
        return;
    }

    if (!audioContext) {
        audioContext = new AudioContextClass();
    }

    if (audioContext.state === 'suspended') {
        await audioContext.resume();
    }

    if (!isPlaying) {
        startPlayback();
    } else {
        stopPlayback();
    }
}

function startPlayback() {
    if (!sequence.length) return;

    isPlaying = true;

    scheduleMeasureIndex = 0;
    scheduleNoteIndex = 0;

    lastRenderedMeasureIndex = -1;

    nextNoteTime = audioContext.currentTime + 0.05;

    if (startStopBtn) {
        startStopBtn.textContent = 'STOP';
        startStopBtn.classList.add('running');
    }

    clearInterval(timerID);
    timerID = setInterval(scheduler, LOOKAHEAD_MS);

    scheduler();
}

function stopPlayback() {
    isPlaying = false;

    clearInterval(timerID);
    timerID = null;

    if (beatContainer) {
        const circles =
            beatContainer.querySelectorAll('.beat-circle');

        circles.forEach((circle) => {
            circle.classList.remove('active');
        });
    }

    if (startStopBtn) {
        startStopBtn.textContent = 'START';
        startStopBtn.classList.remove('running');
    }

    lastRenderedMeasureIndex = -1;
}

// ==========================================
// イベント登録
// ==========================================

function registerEvents() {
    registerBpmEvents();

    if (startStopBtn) {
        startStopBtn.addEventListener('click', () => {
            startStop().catch((error) => {
                console.error('再生処理に失敗しました:', error);
                stopPlayback();
            });
        });
    }

    // 選択中の小節の直後に、初期状態の小節を追加する。
    if (addMeasureBtn) {
        addMeasureBtn.addEventListener('click', () => {
            const newMeasure = {
                beats: 4,
                unit: 4,
                sub: [1, 1, 1, 1]
            };

            const insertIndex = currentMeasureIndex + 1;

            sequence.splice(insertIndex, 0, newMeasure);

            beatMutedByMeasure.splice(
                insertIndex,
                0,
                [false, false, false, false]
            );

            currentMeasureIndex = insertIndex;

            // 再生位置が挿入位置以降なら、位置をずらして
            // 同じ既存小節を指すようにする。
            if (scheduleMeasureIndex >= insertIndex) {
                scheduleMeasureIndex++;
            }

            lastRenderedMeasureIndex = -1;

            renderMeasureSequenceUI();
            renderBeatCircles(sequence[currentMeasureIndex]);
            saveSettings();
        });
    }

    if (resetSeqBtn) {
        resetSeqBtn.addEventListener('click', resetSettings);
    }

    if (globalSubdivSelect) {
        globalSubdivSelect.addEventListener('change', (event) => {
            const value = Number(event.target.value);
            const measure = sequence[currentMeasureIndex];

            if (!measure) return;

            if (!SUBDIVISION_TYPES.some(
                option => option.value === value
            )) {
                return;
            }

            measure.sub = new Array(measure.beats).fill(value);

            renderBeatCircles(measure);
            saveSettings();
        });
    }
}

// ==========================================
// Service Worker 登録 (PWA)
// ==========================================

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then((registration) => {
                console.log(
                    'Service Worker 登録成功:',
                    registration
                );
            })
            .catch((error) => {
                console.error(
                    'Service Worker 登録失敗:',
                    error
                );
            });
    });
}

// ==========================================
// 起動
// ==========================================

init();
