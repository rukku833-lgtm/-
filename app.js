
/* Web Audio APIのコンテキスト準備 */
const AudioContextClass = window.AudioContext || window.webkitAudioContext;
let audioContext = null;

/* ローカルストレージのキー名 */
const STORAGE_KEY = 'web_metronome_settings_v2';

/* デフォルト設定 */
const DEFAULT_TEMPO = 100;

const DEFAULT_SEQUENCE = [
    { beats: 4, unit: 4, sub: [1, 1, 1, 1] },
    { beats: 4, unit: 4, sub: [1, 1, 1, 1] },
    { beats: 4, unit: 4, sub: [1, 1, 1, 1] },
    { beats: 3, unit: 4, sub: [1, 1, 1] }
];

/* サブディビジョン（音符分割数）定義 */
const SUBDIVISION_TYPES = [
    { value: 1, label: '4分' },
    { value: 2, label: '8分' },
    { value: 3, label: '3連' },
    { value: 4, label: '16分'},
    { value: 5, label: '5連' },
    { value: 6, label: '6連' },
    { value: 7, label: '7連' },
    { value: 8, label: '8連' }
];

/* ステート管理 */
let tempo = DEFAULT_TEMPO;
let sequence = JSON.parse(JSON.stringify(DEFAULT_SEQUENCE));
let isPlaying = false;
let currentMeasureIndex = 0;
let currentNote = 0;
let nextNoteTime = 0.0;

const lookahead = 25.0;
const scheduleAheadTime = 0.1;

let timerID = null;
let beatMuted = [];

/* DOM要素の取得 */
const bpmInput = document.getElementById('bpmInput');
const minusBtn = document.getElementById('minusBtn');
const plusBtn = document.getElementById('plusBtn');
const startStopBtn = document.getElementById('startStopBtn');
const measureList = document.getElementById('measureList');
const addMeasureBtn = document.getElementById('addMeasureBtn');
const resetSeqBtn = document.getElementById('resetSeqBtn');
const globalSubdivSelect = document.getElementById('globalSubdivSelect');
const beatContainer = document.getElementById('beatContainer');
const currentMeasureDisplay = document.getElementById('currentMeasureDisplay');

const timeSignatureOptions = [
    { label: '4/4 拍子', beats: 4, unit: 4 },
    { label: '3/4 拍子', beats: 3, unit: 4 },
    { label: '2/4 拍子', beats: 2, unit: 4 },
    { label: '6/8 拍子', beats: 6, unit: 8 },
    { label: '3/8 拍子', beats: 3, unit: 8 },
    { label: '5/4 拍子', beats: 5, unit: 4 },
    { label: '7/8 拍子', beats: 7, unit: 8 }
];

/* ==========================================
   データの保存・読み込み（localStorage）
========================================== */

function saveSettings() {
    const data = {
        tempo: tempo,
        sequence: sequence
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function loadSettings() {
    const saved = localStorage.getItem(STORAGE_KEY);

    if (saved) {
        try {
            const data = JSON.parse(saved);

            if (
                data.tempo &&
                Array.isArray(data.sequence) &&
                data.sequence.length > 0
            ) {
                tempo = data.tempo;

                sequence = data.sequence.map(item => ({
                    beats: item.beats,
                    unit: item.unit,
                    sub: (
                        Array.isArray(item.sub) &&
                        item.sub.length === item.beats
                    )
                        ? item.sub
                        : new Array(item.beats).fill(1)
                }));
            }
        } catch (e) {
            console.error('設定の読み込みに失敗しました:', e);
        }
    }
}

function resetSettings() {
    if (confirm('小節パターンとテンポを初期状態に戻しますか？')) {
        tempo = DEFAULT_TEMPO;
        sequence = JSON.parse(JSON.stringify(DEFAULT_SEQUENCE));
        currentMeasureIndex = 0;
        currentNote = 0;

        saveSettings();

        bpmInput.value = tempo;

        renderMeasureSequenceUI();
        renderBeatCircles(sequence[currentMeasureIndex]);
    }
}

/* ==========================================
   UI描画処理
========================================== */

function renderMeasureSequenceUI() {
    measureList.innerHTML = '';

    sequence.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = `measure-item ${
            index === currentMeasureIndex ? 'active-measure' : ''
        }`;

        const label = document.createElement('span');
        label.className = 'measure-label';
        label.textContent = `小節 ${index + 1}:`;

        const select = document.createElement('select');
        select.className = 'measure-select';

        timeSignatureOptions.forEach(opt => {
            const option = document.createElement('option');

            option.value = `${opt.beats}/${opt.unit}`;
            option.textContent = opt.label;

            if (opt.beats === item.beats && opt.unit === item.unit) {
                option.selected = true;
            }

            select.appendChild(option);
        });

        select.addEventListener('change', (e) => {
            const [b, u] = e.target.value.split('/').map(Number);

            sequence[index].beats = b;
            sequence[index].unit = u;

            // 拍数変更時はデフォルト4分
            sequence[index].sub = new Array(b).fill(1);

            if (index === currentMeasureIndex) {
                renderBeatCircles(sequence[currentMeasureIndex]);
            }

            updateStatusDisplay();
            saveSettings();
        });

        const delBtn = document.createElement('button');
        delBtn.className = 'btn-delete-measure';
        delBtn.textContent = '✕';
        delBtn.title = '小節を削除';

        delBtn.addEventListener('click', () => {
            if (sequence.length <= 1) {
                alert('最低1つの小節が必要です');
                return;
            }

            sequence.splice(index, 1);

            if (currentMeasureIndex >= sequence.length) {
                currentMeasureIndex = 0;
            }

            renderMeasureSequenceUI();
            renderBeatCircles(sequence[currentMeasureIndex]);
            saveSettings();
        });

        div.appendChild(label);
        div.appendChild(select);
        div.appendChild(delBtn);

        measureList.appendChild(div);
    });

    updateStatusDisplay();
}

/* 拍ボタンと個別音符セレクトの動的生成 */
function renderBeatCircles(measureData) {
    beatContainer.innerHTML = '';

    const beatsCount = measureData.beats;
    beatMuted = new Array(beatsCount).fill(false);

    for (let i = 0; i < beatsCount; i++) {
        const itemWrapper = document.createElement('div');
        itemWrapper.className = 'beat-item';

        /* 拍ボタン（丸） */
        const btn = document.createElement('button');
        btn.className = 'beat-circle';
        btn.dataset.beat = i;

        const span = document.createElement('span');
        span.className = 'beat-num';
        span.textContent = i + 1;

        btn.appendChild(span);

        btn.addEventListener('click', () => {
            beatMuted[i] = !beatMuted[i];

            if (beatMuted[i]) {
                btn.classList.add('muted');
            } else {
                btn.classList.remove('muted');
            }
        });

        /* 拍ごとの個別音符セレクトボックス */
        const subSelect = document.createElement('select');
        subSelect.className = 'beat-subdiv-select';

        SUBDIVISION_TYPES.forEach(subOpt => {
            const option = document.createElement('option');

            option.value = subOpt.value;
            option.textContent = subOpt.label;

            if (measureData.sub[i] === subOpt.value) {
                option.selected = true;
            }

            subSelect.appendChild(option);
        });

        subSelect.addEventListener('change', (e) => {
            const val = parseInt(e.target.value, 10);

            measureData.sub[i] = val;
            saveSettings();
        });

        itemWrapper.appendChild(btn);
        itemWrapper.appendChild(subSelect);
        beatContainer.appendChild(itemWrapper);
    }
}

/* 全拍一括で音符を変更するイベント */
globalSubdivSelect.addEventListener('change', (e) => {
    const val = parseInt(e.target.value, 10);
    const currentMeasure = sequence[currentMeasureIndex];

    for (let i = 0; i < currentMeasure.beats; i++) {
        currentMeasure.sub[i] = val;
    }

    renderBeatCircles(currentMeasure);
    saveSettings();
});

function updateStatusDisplay() {
    const current = sequence[currentMeasureIndex] || sequence[0];

    currentMeasureDisplay.textContent =
        `第 ${currentMeasureIndex + 1} / ${sequence.length} 小節 ` +
        `(${current.beats}/${current.unit}拍子)`;

    const items = measureList.querySelectorAll('.measure-item');

    items.forEach((item, idx) => {
        if (idx === currentMeasureIndex) {
            item.classList.add('active-measure');
        } else {
            item.classList.remove('active-measure');
        }
    });
}

let lastRenderedMeasureIndex = -1;

function updateVisualBeat(measureIndex, beatNumber) {
    if (lastRenderedMeasureIndex !== measureIndex) {
        lastRenderedMeasureIndex = measureIndex;
        currentMeasureIndex = measureIndex;

        renderBeatCircles(sequence[currentMeasureIndex]);
        updateStatusDisplay();
    } else {
        currentMeasureIndex = measureIndex;
        updateStatusDisplay();
    }

    const circles = beatContainer.querySelectorAll('.beat-circle');

    circles.forEach((circle, index) => {
        if (index === beatNumber) {
            circle.classList.add('active');
        } else {
            circle.classList.remove('active');
        }
    });
}

/* ==========================================
   音声・タイマー制御（サブディビジョン対応）
========================================== */

function scheduleNote(measureIndex, beatNumber, time) {
    const measure = sequence[measureIndex];
    const subCount = measure.sub[beatNumber] || 1;

    // 1(4分), 2(8分), 3(3連), 4(16分)
    const secondsPerMainBeat =
        (60.0 / tempo) * (4.0 / measure.unit);

    const subInterval = secondsPerMainBeat / subCount;

    // メイン拍の頭で丸ボタンを光らせる
    const drawDelay = Math.max(
        0,
        (time - audioContext.currentTime) * 1000
    );

    setTimeout(() => {
        if (isPlaying) {
            updateVisualBeat(measureIndex, beatNumber);
        }
    }, drawDelay);

    // サブビート（裏拍・分割音）も含めて予約
    for (let s = 0; s < subCount; s++) {
        const noteTime = time + (s * subInterval);

        if (!beatMuted[beatNumber]) {
            const osc = audioContext.createOscillator();
            const envelope = audioContext.createGain();

            if (s === 0) {
                // 表拍（1拍目＝高音1200Hz、その他＝800Hz）
                osc.frequency.value = (beatNumber === 0) ? 1200 : 800;
                envelope.gain.value = 1.0;

                envelope.gain.exponentialRampToValueAtTime(
                    1.0,
                    noteTime + 0.001
                );

                envelope.gain.exponentialRampToValueAtTime(
                    0.001,
                    noteTime + 0.025
                );
            } else {
                // 裏拍・分割音（600Hz、やや抑えめの音量）
                osc.frequency.value = 600;
                envelope.gain.value = 0.4;

                envelope.gain.exponentialRampToValueAtTime(
                    0.4,
                    noteTime + 0.001
                );

                envelope.gain.exponentialRampToValueAtTime(
                    0.001,
                    noteTime + 0.015
                );
            }

            osc.connect(envelope);
            envelope.connect(audioContext.destination);

            osc.start(noteTime);
            osc.stop(noteTime + 0.03);
        }
    }
}

function scheduler() {
    while (
        nextNoteTime <
        audioContext.currentTime + scheduleAheadTime
    ) {
        const currentMeasure = sequence[currentMeasureIndex];

        scheduleNote(
            currentMeasureIndex,
            currentNote,
            nextNoteTime
        );

        const secondsPerBeat =
            (60.0 / tempo) * (4.0 / currentMeasure.unit);

        nextNoteTime += secondsPerBeat;
        currentNote++;

        if (currentNote >= currentMeasure.beats) {
            currentNote = 0;
            currentMeasureIndex =
                (currentMeasureIndex + 1) % sequence.length;
        }
    }
}

function setTempo(newTempo) {
    let val = parseInt(newTempo, 10);

    if (isNaN(val)) return;

    val = Math.max(30, Math.min(300, val));
    tempo = val;
    bpmInput.value = tempo;

    saveSettings();
}

function startStop() {
    if (!audioContext) {
        audioContext = new AudioContextClass();
    }

    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }

    isPlaying = !isPlaying;

    if (isPlaying) {
        currentMeasureIndex = 0;
        currentNote = 0;
        lastRenderedMeasureIndex = -1;
        nextNoteTime = audioContext.currentTime + 0.05;

        renderBeatCircles(sequence[0]);
        updateStatusDisplay();

        timerID = setInterval(scheduler, lookahead);

        startStopBtn.textContent = 'STOP';
        startStopBtn.classList.add('running');
    } else {
        clearInterval(timerID);

        const circles = beatContainer.querySelectorAll('.beat-circle');

        circles.forEach(circle => {
            circle.classList.remove('active');
        });

        startStopBtn.textContent = 'START';
        startStopBtn.classList.remove('running');
    }
}

/* イベントリスナーの登録 */
addMeasureBtn.addEventListener('click', () => {
    const lastMeasure = sequence[sequence.length - 1] || {
        beats: 4,
        unit: 4,
        sub: [1, 1, 1, 1]
    };

    sequence.push({
        beats: lastMeasure.beats,
        unit: lastMeasure.unit,
        sub: [...lastMeasure.sub]
    });

    renderMeasureSequenceUI();
    saveSettings();
});

if (resetSeqBtn) {
    resetSeqBtn.addEventListener('click', resetSettings);
}

minusBtn.addEventListener('click', () => {
    setTempo(tempo - 1);
});

plusBtn.addEventListener('click', () => {
    setTempo(tempo + 1);
});

bpmInput.addEventListener('input', (e) => {
    setTempo(e.target.value);
});

bpmInput.addEventListener('blur', () => {
    bpmInput.value = tempo;
});

startStopBtn.addEventListener('click', startStop);

/* 初期描画処理 */
loadSettings();
bpmInput.value = tempo;

renderMeasureSequenceUI();
renderBeatCircles(sequence[0]);
