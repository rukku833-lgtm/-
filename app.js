
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

const STORAGE_KEY = 'web_metronome_settings_v7';

const DEFAULT_TEMPO = 100;
const MIN_TEMPO = 30;
const MAX_TEMPO = 300;
const DRAG_SENSITIVITY = 5;

const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD_TIME = 0.1;

const DEFAULT_SEQUENCE = [
    { beats: 4, unit: 4, sub: new Array(4).fill(1) }
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

let isPlaying = false;

// 表示用の小節・拍
let currentMeasureIndex = 0;
let currentNote = 0;

// スケジューラー専用の小節・拍
let scheduleMeasureIndex = 0;
let scheduleNoteIndex = 0;

let nextNoteTime = 0;
let timerID = null;
let lastRenderedMeasureIndex = -1;

let beatMutedByMeasure = [];

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
    renderBeatCircles(sequence[0]);

    registerEvents();
}

function normalizeSequence() {
    if (!Array.isArray(sequence) || sequence.length === 0) {
        sequence = structuredClone(DEFAULT_SEQUENCE);
    }

    sequence = sequence.map((item) => {
        const beats = Number(item.beats);
        const unit = Number(item.unit);

        const validBeats =
            Number.isInteger(beats) && beats >= 1 && beats <= 32
                ? beats
                : 4;

        const validUnit = [2, 4, 8, 16].includes(unit)
            ? unit
            : 4;

        const sub = Array.isArray(item.sub)
            ? Array.from({ length: validBeats }, (_, index) => {
                const value = Number(item.sub[index]);

                return SUBDIVISION_TYPES.some(
                    option => option.value === value
                )
                    ? value
                    : 1;
            })
            : new Array(validBeats).fill(1);

        return {
            beats: validBeats,
            unit: validUnit,
            sub
        };
    });

    tempo = clampTempo(tempo);

    currentMeasureIndex = Math.min(
        currentMeasureIndex,
        sequence.length - 1
    );
}

function initializeMuteStates() {
    beatMutedByMeasure = sequence.map(
        measure => new Array(measure.beats).fill(false)
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
            JSON.stringify({ tempo, sequence })
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

    localStorage.removeItem(STORAGE_KEY);

    tempo = DEFAULT_TEMPO;
    sequence = structuredClone(DEFAULT_SEQUENCE);

    currentMeasureIndex = 0;
    currentNote = 0;
    scheduleMeasureIndex = 0;
    scheduleNoteIndex = 0;
    lastRenderedMeasureIndex = -1;

    initializeMuteStates();

    updateTempoUI();
    renderMeasureSequenceUI();
    renderBeatCircles(sequence[0]);
    updateStatusDisplay();

    saveSettings();
}

// ==========================================
// BPM操作
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
            if (event.button !== undefined && event.button !== 0) return;

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
                // ポインター解放時の例外は無視
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

            const delta =
                event.deltaY !== 0 ? -event.deltaY : event.deltaX;

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
// 小節シーケンスの描画
// ==========================================

function renderMeasureSequenceUI() {
    measureList.innerHTML = '';

    sequence.forEach((measure, index) => {
        const div = document.createElement('div');
        div.className = 'measure-item';

        if (index === currentMeasureIndex) {
            div.classList.add('active-measure');
        }

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

            beatMutedByMeasure[index] =
                Array.from(
                    { length: beats },
                    (_, beatIndex) =>
                        oldMuteState[beatIndex] ?? false
                );

            if (index === currentMeasureIndex) {
                currentNote = Math.min(currentNote, beats - 1);
                scheduleNoteIndex = Math.min(
                    scheduleNoteIndex,
                    beats - 1
                );

                renderBeatCircles(sequence[index]);
            }

            renderMeasureSequenceUI();
            saveSettings();
        });

        const deleteButton = document.createElement('button');
        deleteButton.className = 'btn-delete-measure';
        deleteButton.textContent = '✕';
        deleteButton.title = '小節を削除';

        deleteButton.addEventListener('click', () => {
            if (sequence.length <= 1) {
                alert('最低1つの小節が必要です');
                return;
            }

            sequence.splice(index, 1);
            beatMutedByMeasure.splice(index, 1);

            if (currentMeasureIndex > index) {
                currentMeasureIndex--;
            } else if (currentMeasureIndex === index) {
                currentMeasureIndex = Math.min(
                    index,
                    sequence.length - 1
                );
                currentNote = 0;
            }

            if (scheduleMeasureIndex > index) {
                scheduleMeasureIndex--;
            } else if (scheduleMeasureIndex >= sequence.length) {
                scheduleMeasureIndex = 0;
                scheduleNoteIndex = 0;
            }

            lastRenderedMeasureIndex = -1;

            renderMeasureSequenceUI();
            renderBeatCircles(sequence[currentMeasureIndex]);
            updateStatusDisplay();

            saveSettings();
        });

        div.append(label, select, deleteButton);
        measureList.appendChild(div);
    });

    updateStatusDisplay();
}

// ==========================================
// 拍ボタン・音符分割の描画
// ==========================================

function renderBeatCircles(measureData) {
    beatContainer.innerHTML = '';

    if (!measureData) return;

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
        });

        const select = document.createElement('select');
        select.className = 'beat-subdiv-select';

        SUBDIVISION_TYPES.forEach((subdivision) => {
            const option = document.createElement('option');

            option.value = subdivision.value;
            option.textContent = subdivision.label;
            option.selected =
                measureData.sub[i] === subdivision.value;

            select.appendChild(option);
        });

        select.addEventListener('change', (event) => {
            measureData.sub[i] = Number(event.target.value);
            saveSettings();
        });

        wrapper.append(button, select);
        beatContainer.appendChild(wrapper);
    }
}

function updateStatusDisplay() {
    const measure = sequence[currentMeasureIndex] || sequence[0];

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

    currentMeasureIndex = measureIndex;
    currentNote = beatNumber;

    if (lastRenderedMeasureIndex !== measureIndex) {
        lastRenderedMeasureIndex = measureIndex;

        renderBeatCircles(sequence[measureIndex]);
        updateStatusDisplay();
    }

    const circles = beatContainer.querySelectorAll('.beat-circle');

    circles.forEach((circle, index) => {
        circle.classList.toggle('active', index === beatNumber);
    });
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
            playClick(noteTime, 600, 0.3, 0.015);
        }
    }
}

function scheduler() {
    if (!isPlaying || !audioContext || sequence.length === 0) {
        return;
    }

    while (
        nextNoteTime <
        audioContext.currentTime + SCHEDULE_AHEAD_TIME
    ) {
        const measureIndex = scheduleMeasureIndex;
        const noteNumber = scheduleNoteIndex;
        const measure = sequence[measureIndex];

        if (!measure) {
            scheduleMeasureIndex = 0;
            scheduleNoteIndex = 0;
            continue;
        }

        scheduleNote(measureIndex, noteNumber, nextNoteTime);

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
        alert('このブラウザでは音声再生に対応していません。');
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
    if (sequence.length === 0) {
        sequence = structuredClone(DEFAULT_SEQUENCE);
        initializeMuteStates();
    }

    isPlaying = true;

    currentMeasureIndex = 0;
    currentNote = 0;

    scheduleMeasureIndex = 0;
    scheduleNoteIndex = 0;

    lastRenderedMeasureIndex = -1;

    nextNoteTime = audioContext.currentTime + 0.05;

    renderMeasureSequenceUI();
    renderBeatCircles(sequence[0]);
    updateStatusDisplay();

    clearInterval(timerID);
    timerID = setInterval(scheduler, LOOKAHEAD_MS);

    startStopBtn.textContent = 'STOP';
    startStopBtn.classList.add('running');

    scheduler();
}

function stopPlayback() {
    isPlaying = false;

    clearInterval(timerID);
    timerID = null;

    const circles = beatContainer.querySelectorAll('.beat-circle');

    circles.forEach((circle) => {
        circle.classList.remove('active');
    });

    if (startStopBtn) {
        startStopBtn.textContent = 'START';
        startStopBtn.classList.remove('running');
    }
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

    if (addMeasureBtn) {
        addMeasureBtn.addEventListener('click', () => {
            const lastMeasure = sequence[sequence.length - 1];

            sequence.push({
                beats: lastMeasure.beats,
                unit: lastMeasure.unit,
                sub: [...lastMeasure.sub]
            });

            beatMutedByMeasure.push(
                new Array(lastMeasure.beats).fill(false)
            );

            renderMeasureSequenceUI();
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
            .then(reg => {
                console.log('Service Worker 登録成功:', reg);
            })
            .catch(err => {
                console.error('Service Worker 登録失敗:', err);
            });
    });
}

// ==========================================
// 起動
// ==========================================

init();
