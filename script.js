// AutoStat AI Agent - Statistical Analysis Engine (upload-safe + live streaming math)

const AUTOSTAT_CONFIG = {
  maxResultsCards: 10,
  maxLogEntries: 50,
  chartWindow: 50,

  logistic: {
    iterations: 900,
    learningRate: 0.12,
    threshold: 0.5,
    binarizeMethod: "median",
    standardizeX: true,
    maxPredictorsPerRun: 6,
    uiUpdateEvery: 50, // iterations
  },

  autoMode: {
    useMultipleLinearRegression: true, // uses simple-statistics if available
  },

  missing: {
    strategy: "drop",
  },
};

function fmt(n, digits = 4) {
  return Number.isFinite(n) ? n.toFixed(digits) : "-";
}
function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function writeMath(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
}
function appendMath(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent += text;
}
function safeSum(arr) {
  let s = 0;
  for (const v of arr) s += v;
  return s;
}
function safeSumSq(arr) {
  let s = 0;
  for (const v of arr) s += v * v;
  return s;
}
function safeSumXY(X, y) {
  let s = 0;
  for (let i = 0; i < X.length; i++) s += X[i] * y[i];
  return s;
}
function logLoss(probs, y) {
  let total = 0;
  const eps = 1e-12;
  for (let i = 0; i < probs.length; i++) {
    const p = Math.min(1 - eps, Math.max(eps, probs[i]));
    total += -(y[i] * Math.log(p) + (1 - y[i]) * Math.log(1 - p));
  }
  return total / probs.length;
}
function rafYield() {
  return new Promise(requestAnimationFrame);
}

class StatisticalAgent {
  constructor() {
    this.isRunning = false;
    this.intervalId = null;
    this.uptimeInterval = null;
    this.startTime = null;

    this.stats = {
      linear: { count: 0, r2Scores: [], bestR2: -Infinity, slopes: [] },
      logistic: { count: 0, accuracies: [], bestAcc: 0, precisions: [] },
      totalRuns: 0,
      dataPoints: 0,
      mixedFlip: 0,
    };

    this.linearChart = null;
    this.logisticChart = null;
    this.comparisonChart = null;

    this.variableNames = [];
    this.uploadedData = null;
    this.uploadedColumns = [];

    this.combinationResults = [];
    this.currentCombinationIndex = 0;
    this.combinations = [];
    this.isAutoMode = false;
    this.targetVariable = null;

    this.initCharts();
    this.generateVariableNames();
    this.initFileUpload();   // IMPORTANT: keeps your working upload behavior
    this.initModeUI();
  }

  getAnalysisType() {
    const sel = document.getElementById("analysis-type");
    return sel ? sel.value : "linear";
  }

  initModeUI() {
    const sel = document.getElementById("analysis-type");
    const linearCard = document.getElementById("linear-card");
    const logisticCard = document.getElementById("logistic-card");

    const apply = () => {
      const mode = this.getAnalysisType();
      if (linearCard) linearCard.classList.toggle("hidden", mode !== "linear");
      if (logisticCard) logisticCard.classList.toggle("hidden", mode !== "logistic");
    };

    if (sel) sel.addEventListener("change", apply);
    apply();
  }

  /* =========================
     Upload (WORKING VERSION)
     ========================= */
  initFileUpload() {
    const fileInput = document.getElementById("excel-file");
    const uploadArea = document.getElementById("upload-area");

    // Click to upload
    uploadArea.addEventListener("click", (e) => {
      if (e.target !== fileInput) {
        fileInput.click();
      }
    });

    // Drag and drop
    uploadArea.addEventListener("dragover", (e) => {
      e.preventDefault();
      uploadArea.classList.add("border-purple-500", "bg-purple-50");
    });

    uploadArea.addEventListener("dragleave", () => {
      uploadArea.classList.remove("border-purple-500", "bg-purple-50");
    });

    uploadArea.addEventListener("drop", (e) => {
      e.preventDefault();
      uploadArea.classList.remove("border-purple-500", "bg-purple-50");
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        this.handleFile(files[0]);
      }
      // allow re-selecting same file later
      fileInput.value = "";
    });

    // File selection
    fileInput.addEventListener("change", (e) => {
      if (e.target.files.length > 0) {
        this.handleFile(e.target.files[0]);
      }
      // allow re-selecting same file later
      fileInput.value = "";
    });
  }

  handleFile(file) {
    if (!file.name.match(/\.(xlsx|xls)$/i)) {
      alert("Please upload an Excel file (.xlsx or .xls)");
      return;
    }

    document.getElementById("filename-display").textContent = file.name;

    const reader = new FileReader();
    reader.onerror = () => {
      alert("Error reading file. Please try again.");
      this.log("File read error", "orange");
    };
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: "array" });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
        this.parseExcelData(jsonData);
        this.log(`File uploaded: ${file.name}`, "green");
      } catch (error) {
        console.error("Error parsing Excel:", error);
        alert("Error parsing Excel file. Please try again.");
        this.log("Error parsing Excel file", "orange");
      }
    };
    reader.readAsArrayBuffer(file);
  }

  parseExcelData(rawData) {
    if (rawData.length < 2) {
      alert("Excel file must have at least a header row and one data row");
      return;
    }

    const headers = rawData[0].map((h, i) => (h ? String(h).trim() : `Column_${i + 1}`));
    const data = [];

    for (let i = 1; i < rawData.length; i++) {
      const row = rawData[i];
      if (!row || row.length === 0) continue;

      const rowData = {};
      let hasValidData = false;

      headers.forEach((header, index) => {
        const value = row[index];
        const numValue = parseFloat(value);
        rowData[header] = (value !== undefined && value !== "" && !isNaN(numValue)) ? numValue : value;
        if (value !== undefined && value !== "") hasValidData = true;
      });

      if (hasValidData) data.push(rowData);
    }

    this.uploadedData = data;
    this.uploadedColumns = headers;

    const numericCount = headers.filter((h) => this.isNumericColumn(h)).length;
    document.getElementById("file-stats").textContent =
      `${data.length} rows × ${headers.length} columns | ${numericCount} numeric columns`;
    document.getElementById("file-info").classList.remove("hidden");

    this.populateVariableSelectors(headers);
    document.getElementById("variable-selection").classList.remove("hidden");
    this.showDataPreview(data, headers);

    this.log(`Parsed ${data.length} rows with ${headers.length} columns`, "green");
  }

  isNumericColumn(columnName) {
    if (!this.uploadedData || this.uploadedData.length === 0) return true;

    let numericCount = 0;
    let totalCount = 0;
    for (const row of this.uploadedData.slice(0, 15)) {
      const val = row[columnName];
      if (val !== undefined && val !== null && val !== "") {
        totalCount++;
        if (typeof val === "number" && !isNaN(val)) numericCount++;
      }
    }
    return totalCount > 0 && numericCount / totalCount > 0.6;
  }

  populateVariableSelectors(headers) {
    const targetSelect = document.getElementById("target-variable");
    const predictorSelect = document.getElementById("predictor-variables");

    targetSelect.innerHTML = '<option value="">Select target...</option>';
    predictorSelect.innerHTML = "";

    const numericHeaders = headers.filter((h) => this.isNumericColumn(h));

    headers.forEach((header) => {
      const isNumeric = this.isNumericColumn(header);
      const optionText = isNumeric ? header : `${header} (non-numeric)`;

      const targetOption = document.createElement("option");
      targetOption.value = header;
      targetOption.textContent = optionText;
      if (!isNumeric) targetOption.disabled = true;
      targetSelect.appendChild(targetOption);

      const predictorOption = document.createElement("option");
      predictorOption.value = header;
      predictorOption.textContent = optionText;
      if (!isNumeric) predictorOption.disabled = true;
      predictorSelect.appendChild(predictorOption);
    });

    const pickPreds = numericHeaders.slice(0, 3);
    for (const opt of predictorSelect.options) opt.selected = pickPreds.includes(opt.value);
    if (numericHeaders.length > 0) targetSelect.value = numericHeaders[numericHeaders.length - 1];
  }

  showDataPreview(data, headers) {
    const previewContainer = document.getElementById("data-preview");
    const thead = document.getElementById("preview-header");
    const tbody = document.getElementById("preview-body");

    thead.innerHTML =
      "<tr>" +
      headers.map((h) => `<th class="px-3 py-2 text-left font-medium text-gray-700 border-b">${h}</th>`).join("") +
      "</tr>";

    tbody.innerHTML = data.slice(0, 5).map((row) =>
      "<tr class='border-b'>" +
      headers.map((h) => `<td class="px-3 py-2 text-gray-600 truncate max-w-xs">${row[h] ?? ""}</td>`).join("") +
      "</tr>"
    ).join("");

    previewContainer.classList.remove("hidden");
  }

  /* =========================
     Data generation / selection
     ========================= */
  generateVariableNames() {
    const prefixes = ["Revenue","Traffic","Conversion","Engagement","Retention","Satisfaction","Churn","Growth","Efficiency","Quality","Speed","Cost","Profit","Risk","Score"];
    const suffixes = ["Rate","Index","Level","Count","Ratio","Value","Metric"];

    this.variableNames = [];
    for (let i = 0; i < 20; i++) {
      const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
      const suffix = suffixes[Math.floor(Math.random() * suffixes.length)];
      this.variableNames.push(`${prefix}_${suffix}_${String.fromCharCode(65 + i)}`);
    }
  }

  generateData(sampleSize, numVars) {
    const data = [];
    const selectedVars = this.variableNames.slice(0, numVars);
    const baseTrend = Array.from({ length: sampleSize }, (_, i) => i / sampleSize);

    for (let i = 0; i < sampleSize; i++) {
      const row = {};
      selectedVars.forEach((varName) => {
        const noise = (Math.random() - 0.5) * 0.3;
        const trendComponent = baseTrend[i] * (0.5 + Math.random());
        row[varName] = trendComponent + noise + Math.random() * 0.5;
      });
      data.push(row);
    }

    return {
      data,
      predictors: selectedVars.slice(0, Math.max(1, selectedVars.length - 1)),
      targetVar: selectedVars[selectedVars.length - 1],
      isUploaded: false
    };
  }

  getDataForAnalysis(sampleSize) {
    const dataMode = document.getElementById("data-mode").value;

    if (dataMode === "mixed" && this.uploadedData) {
      this.stats.mixedFlip++;
      if (this.stats.mixedFlip % 2 === 1) return this.generateData(sampleSize, 5);
    }

    if (dataMode === "generated" || !this.uploadedData) {
      return this.generateData(sampleSize, 5);
    }

    let data = this.uploadedData;
    if (sampleSize < data.length) {
      const indices = new Set();
      while (indices.size < sampleSize) indices.add(Math.floor(Math.random() * data.length));
      data = Array.from(indices).map((i) => data[i]);
    }

    const targetVar = document.getElementById("target-variable").value;

    const predictorVars = Array.from(document.getElementById("predictor-variables").selectedOptions)
      .map((o) => o.value)
      .filter((v) => v !== targetVar);

    const effectivePredictors =
      predictorVars.length > 0
        ? predictorVars
        : this.uploadedColumns.filter((c) => this.isNumericColumn(c) && c !== targetVar);

    return { data, predictors: effectivePredictors, targetVar: targetVar || effectivePredictors[effectivePredictors.length - 1], isUploaded: true };
  }

  /* =========================
     Modeling helpers
     ========================= */
  buildMatrixAndVector(data, predictors, target) {
    const X = [];
    const y = [];

    for (const row of data) {
      const t = row[target];
      const xs = predictors.map((p) => row[p]);

      const missing =
        t === undefined || t === null || t === "" || (typeof t === "number" && isNaN(t)) ||
        xs.some((v) => v === undefined || v === null || v === "" || (typeof v === "number" && isNaN(v)));

      if (missing && AUTOSTAT_CONFIG.missing.strategy === "drop") continue;

      const xRow = xs.map((v) => (typeof v === "number" ? v : (parseFloat(v) || 0)));
      const yy = (typeof t === "number" ? t : (parseFloat(t) || 0));

      if (!Number.isFinite(yy) || xRow.some((v) => !Number.isFinite(v))) continue;

      X.push(xRow);
      y.push(yy);
    }

    return { X, y };
  }

  standardizeMatrix(X) {
    if (!X.length) return { X: [] };
    const p = X[0].length;
    const means = Array(p).fill(0);
    const stds = Array(p).fill(1);

    for (let j = 0; j < p; j++) {
      let s = 0;
      for (let i = 0; i < X.length; i++) s += X[i][j];
      means[j] = s / X.length;
    }

    for (let j = 0; j < p; j++) {
      let v = 0;
      for (let i = 0; i < X.length; i++) {
        const d = X[i][j] - means[j];
        v += d * d;
      }
      const st = Math.sqrt(v / X.length);
      stds[j] = st > 1e-10 ? st : 1;
    }

    return { X: X.map((row) => row.map((v, j) => (v - means[j]) / stds[j])) };
  }

  binarizeTarget(yRaw) {
    if (!yRaw.length) return [];
    if (AUTOSTAT_CONFIG.logistic.binarizeMethod === "mean") {
      const mean = yRaw.reduce((a, b) => a + b, 0) / yRaw.length;
      return yRaw.map((v) => (v > mean ? 1 : 0));
    }
    const sorted = [...yRaw].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return yRaw.map((v) => (v > median ? 1 : 0));
  }

  /* =========================
     LIVE Linear Regression
     ========================= */
  async linearRegressionLive(X, y) {
    const n = X.length;

    writeMath("math-linear", "Starting linear regression...\n");
    await rafYield();

    const sumX = safeSum(X);
    appendMath("math-linear", `sumX = ${sumX}\n`);
    await rafYield();

    const sumY = safeSum(y);
    appendMath("math-linear", `sumY = ${sumY}\n`);
    await rafYield();

    const sumXY = safeSumXY(X, y);
    appendMath("math-linear", `sumXY = ${sumXY}\n`);
    await rafYield();

    const sumX2 = safeSumSq(X);
    appendMath("math-linear", `sumX2 = ${sumX2}\n`);
    await rafYield();

    const denom = (n * sumX2 - sumX * sumX);
    appendMath("math-linear", `denom = n*sumX2 - (sumX)^2 = ${denom}\n`);
    await rafYield();

    const slope = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
    appendMath("math-linear", `slope = (n*sumXY - sumX*sumY) / denom = ${slope}\n`);
    await rafYield();

    const intercept = (sumY - slope * sumX) / n;
    appendMath("math-linear", `intercept = (sumY - slope*sumX) / n = ${intercept}\n`);
    await rafYield();

    const preds = X.map((xi) => slope * xi + intercept);

    const yMean = sumY / n;
    let ssTotal = 0;
    let ssResidual = 0;
    for (let i = 0; i < n; i++) {
      const d = y[i] - yMean;
      ssTotal += d * d;
      const r = y[i] - preds[i];
      ssResidual += r * r;
      // yield every ~200 rows so UI stays alive on big samples
      if (i % 200 === 0) await rafYield();
    }

    const r2 = (ssTotal === 0) ? 0 : (1 - ssResidual / ssTotal);

    appendMath("math-linear", `\nSS_total = ${ssTotal}\nSS_residual = ${ssResidual}\n`);
    await rafYield();
    appendMath("math-linear", `R² = 1 - SS_residual/SS_total = ${r2}\n`);

    return { slope, intercept, r2, predictions: preds };
  }

  /* =========================
     LIVE Logistic Regression
     ========================= */
  async logisticRegressionLive(X, y, iterations = AUTOSTAT_CONFIG.logistic.iterations, learningRate = AUTOSTAT_CONFIG.logistic.learningRate) {
    const p = X[0].length;
    let weights = Array(p).fill(0);
    let bias = 0;
    const sigmoid = (z) => 1 / (1 + Math.exp(-clamp(z, -35, 35)));

    writeMath("math-logistic",
`Binary logistic regression (gradient descent)

sigmoid(z) = 1 / (1 + e^{-z})
z_i = w·x_i + b

iterations = ${iterations}
learningRate = ${learningRate}
p = ${p}

Starting...
`);
    await rafYield();

    const chunk = AUTOSTAT_CONFIG.logistic.uiUpdateEvery;

    for (let iter = 1; iter <= iterations; iter++) {
      if (!this.isRunning) break;

      let dw = Array(p).fill(0);
      let db = 0;

      for (let i = 0; i < X.length; i++) {
        const z = X[i].reduce((sum, xij, j) => sum + xij * weights[j], 0) + bias;
        const pred = sigmoid(z);
        const error = pred - y[i];

        for (let j = 0; j < p; j++) dw[j] += error * X[i][j];
        db += error;

        if (i % 400 === 0) await rafYield();
      }

      for (let j = 0; j < p; j++) weights[j] -= (learningRate / X.length) * dw[j];
      bias -= (learningRate / X.length) * db;

      if (iter % chunk === 0 || iter === iterations) {
        const probs = X.map((xi) => sigmoid(xi.reduce((s, xij, j) => s + xij * weights[j], 0) + bias));
        const loss = logLoss(probs, y);

        const showW = weights.slice(0, Math.min(6, weights.length)).map((v) => (Number.isFinite(v) ? v.toFixed(6) : "NaN"));
        const wTail = weights.length > 6 ? ", ..." : "";

        appendMath("math-logistic",
`\niter ${iter}/${iterations}
b = ${bias.toFixed(6)}
w = [${showW.join(", ")}${wTail}]
log-loss ≈ ${loss.toFixed(6)}
`);
        await rafYield();
      }
    }

    const predictions = X.map((xi) => {
      const z = xi.reduce((sum, xij, j) => sum + xij * weights[j], 0) + bias;
      return sigmoid(z) > AUTOSTAT_CONFIG.logistic.threshold ? 1 : 0;
    });

    const accuracy = predictions.filter((pHat, i) => pHat === y[i]).length / y.length;
    const tp = predictions.filter((pHat, i) => pHat === 1 && y[i] === 1).length;
    const fp = predictions.filter((pHat, i) => pHat === 1 && y[i] === 0).length;
    const precision = tp / (tp + fp) || 0;

    appendMath("math-logistic",
`\n\nFinal:
threshold = ${AUTOSTAT_CONFIG.logistic.threshold}
accuracy = ${accuracy.toFixed(6)}
precision = ${precision.toFixed(6)}
`);

    return { weights, bias, accuracy, precision, predictions };
  }

  /* =========================
     Charts
     ========================= */
  initCharts() {
    const linearOptions = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { display: false }, y: { suggestedMin: -1, suggestedMax: 1 } },
      elements: { point: { radius: 0 }, line: { tension: 0.25 } },
    };

    const logisticOptions = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { display: false }, y: { beginAtZero: true, suggestedMax: 1 } },
      elements: { point: { radius: 0 }, line: { tension: 0.25 } },
    };

    this.linearChart = new Chart(document.getElementById("linear-chart"), {
      type: "line",
      data: { labels: [], datasets: [{ data: [], borderColor: "#3b82f6", backgroundColor: "rgba(59, 130, 246, 0.1)", fill: true, borderWidth: 2 }] },
      options: linearOptions,
    });

    this.logisticChart = new Chart(document.getElementById("logistic-chart"), {
      type: "line",
      data: { labels: [], datasets: [{ data: [], borderColor: "#8b5cf6", backgroundColor: "rgba(139, 92, 246, 0.1)", fill: true, borderWidth: 2 }] },
      options: logisticOptions,
    });
  }

  /* =========================
     Auto Mode (unchanged behavior)
     ========================= */
  startAutoMode() {
    const targetSelect = document.getElementById("target-variable");
    const predictorSelect = document.getElementById("predictor-variables");
    const groupSizeInput = document.getElementById("predictor-group-size");

    this.targetVariable = targetSelect.value;
    const selectedPredictors = Array.from(predictorSelect.selectedOptions).map((o) => o.value);
    const groupSize = parseInt(groupSizeInput?.value || 2);

    if (!this.targetVariable) {
      alert("Please select a target variable first");
      return;
    }
    if (selectedPredictors.length < groupSize) {
      alert(`Please select at least ${groupSize} predictor variables`);
      return;
    }

    this.combinations = this.generateCombinations(selectedPredictors, groupSize);
    this.combinationResults = [];
    this.currentCombinationIndex = 0;

    document.getElementById("combination-progress").classList.remove("hidden");
    document.getElementById("combination-results").classList.add("hidden");
    this.updateProgressDisplay();

    this.isRunning = true;
    this.startTime = Date.now();
    document.getElementById("status-dot").classList.add("status-running");
    document.getElementById("status-text").textContent = "Auto Mode";
    document.getElementById("toggle-btn").innerHTML = '<i data-lucide="pause" class="w-4 h-4"></i><span>Stop</span>';
    lucide.createIcons();

    const interval = parseInt(document.getElementById("interval").value) * 1000;
    this.runAutoCombination();
    this.intervalId = setInterval(() => this.runAutoCombination(), interval);
    this.uptimeInterval = setInterval(() => this.updateUptime(), 1000);

    this.log(`Auto mode started - testing ${this.combinations.length} combinations`, "green");
  }

  generateCombinations(items, k) {
    const result = [];
    const n = items.length;
    function backtrack(start, current) {
      if (current.length === k) {
        result.push([...current]);
        return;
      }
      for (let i = start; i < n; i++) {
        current.push(items[i]);
        backtrack(i + 1, current);
        current.pop();
      }
    }
    backtrack(0, []);
    return result;
  }

  scoreCombinationLinear(data, predictors, target) {
    const { X, y } = this.buildMatrixAndVector(data, predictors, target);
    if (X.length < predictors.length + 2) return { score: 0, label: "R²" };

    if (
      AUTOSTAT_CONFIG.autoMode.useMultipleLinearRegression &&
      typeof ss !== "undefined" &&
      typeof ss.multipleLinearRegression === "function"
    ) {
      try {
        const rows = X.map((row, i) => [...row, y[i]]);
        const coefs = ss.multipleLinearRegression(rows);
        const preds = X.map((row) => coefs[0] + row.reduce((s, v, j) => s + v * coefs[j + 1], 0));

        // compute R2
        const mean = safeSum(y) / y.length;
        let ssT = 0, ssR = 0;
        for (let i = 0; i < y.length; i++) {
          const d = y[i] - mean;
          ssT += d * d;
          const r = y[i] - preds[i];
          ssR += r * r;
        }
        const r2 = ssT === 0 ? 0 : 1 - ssR / ssT;
        return { score: Number.isFinite(r2) ? r2 : 0, label: "R²" };
      } catch (_) {}
    }

    // fallback: composite
    const X1 = X.map((row) => row.reduce((a, b) => a + b, 0) / row.length);
    const res = this.simpleLinear(X1, y);
    return { score: res.r2, label: "R²" };
  }

  scoreCombinationLogistic(data, predictors, target) {
    const { X: Xraw, y: yRaw } = this.buildMatrixAndVector(data, predictors, target);
    if (Xraw.length < 10) return { score: 0, label: "Accuracy" };

    const y = this.binarizeTarget(yRaw);
    let X = Xraw;
    if (AUTOSTAT_CONFIG.logistic.standardizeX) X = this.standardizeMatrix(Xraw).X;

    // fast non-live logistic for auto mode
    const res = this.logisticRegressionFast(X, y);
    return { score: res.accuracy, label: "Accuracy" };
  }

  async runAutoCombination() {
    if (this.currentCombinationIndex >= this.combinations.length) {
      this.completeAutoMode();
      return;
    }

    const predictors = this.combinations[this.currentCombinationIndex];
    const sampleSize = parseInt(document.getElementById("sample-size").value);
    const analysisType = this.getAnalysisType();

    document.getElementById("current-combination").textContent = `Testing: ${predictors.join(" + ")}`;

    const dataInfo = this.getDataForAnalysis(sampleSize);
    const { data } = dataInfo;

    const scored =
      analysisType === "logistic"
        ? this.scoreCombinationLogistic(data, predictors.slice(0, AUTOSTAT_CONFIG.logistic.maxPredictorsPerRun), this.targetVariable)
        : this.scoreCombinationLinear(data, predictors, this.targetVariable);

    this.combinationResults.push({
      predictors,
      target: this.targetVariable,
      score: scored.score,
      metricLabel: scored.label,
      type: analysisType,
    });

    if (typeof playPing === "function") playPing();

    this.currentCombinationIndex++;
    this.updateProgressDisplay();
    this.updateDashboard();

    this.log(
      `Combination ${this.currentCombinationIndex}/${this.combinations.length}: [${predictors.join(", ")}] → ${scored.label}=${fmt(scored.score, 4)}`,
      analysisType === "logistic" ? "purple" : "blue"
    );
  }

  completeAutoMode() {
    this.stop();

    if (typeof playPing === "function") {
      setTimeout(playPing, 220);
      setTimeout(playPing, 520);
    }

    if (this.combinationResults.length === 0) {
      this.log("Auto mode complete, but no valid models were scored.", "orange");
      return;
    }

    const sorted = [...this.combinationResults].sort((a, b) => b.score - a.score);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];

    document.getElementById("best-model").textContent = `${best.predictors.join(" + ")} → ${best.target}`;
    document.getElementById("best-model-score").textContent = `${best.metricLabel} = ${fmt(best.score, 4)}`;

    document.getElementById("worst-model").textContent = `${worst.predictors.join(" + ")} → ${worst.target}`;
    document.getElementById("worst-model-score").textContent = `${worst.metricLabel} = ${fmt(worst.score, 4)}`;

    document.getElementById("combination-results").classList.remove("hidden");
    document.getElementById("combination-progress").classList.add("hidden");

    this.createComparisonChart(sorted);

    this.log(`Auto mode complete! Best ${best.metricLabel}=${fmt(best.score, 4)}, Worst ${worst.metricLabel}=${fmt(worst.score, 4)}`, "green");

    document.getElementById("status-text").textContent = "Complete";
    document.getElementById("status-dot").classList.remove("status-running");
    document.getElementById("toggle-btn").innerHTML = '<i data-lucide="play" class="w-4 h-4"></i><span>Start New Analysis</span>';
    lucide.createIcons();

    this.isAutoMode = false;
    this.currentCombinationIndex = 0;
  }

  createComparisonChart(sortedResults) {
    if (this.comparisonChart) this.comparisonChart.destroy();

    const metricLabel = sortedResults[0].metricLabel || "Score";
    const scores = sortedResults.map((r) => r.score);
    const min = Math.min(...scores);
    const max = Math.max(...scores);

    const ctx = document.getElementById("comparison-chart").getContext("2d");
    this.comparisonChart = new Chart(ctx, {
      type: "bar",
      data: {
        labels: sortedResults.map((_, i) => `#${i + 1}`),
        datasets: [{
          label: metricLabel,
          data: scores,
          backgroundColor: sortedResults.map((_, i) =>
            i === 0 ? "#10b981" : i === sortedResults.length - 1 ? "#ef4444" : "#6b7280"
          ),
          borderWidth: 1,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => sortedResults[items[0].dataIndex].predictors.join(" + "),
              label: (item) => `${metricLabel} = ${Number.isFinite(item.raw) ? item.raw.toFixed(4) : "-"}`,
            },
          },
        },
        scales: {
          y: {
            beginAtZero: metricLabel !== "R²",
            suggestedMin: metricLabel === "R²" ? Math.min(-1, min) : 0,
            suggestedMax: metricLabel === "R²" ? Math.max(1, max) : 1,
            title: { display: true, text: metricLabel },
          },
          x: { title: { display: true, text: "Model Rank" } },
        },
      },
    });
  }

  /* =========================
     Continuous run (single mode)
     ========================= */
  async runAnalysis() {
    const sampleSize = parseInt(document.getElementById("sample-size").value);
    const analysisType = this.getAnalysisType();

    const dataInfo = this.getDataForAnalysis(sampleSize);
    const { data, predictors, targetVar, isUploaded } = dataInfo;

    if (!targetVar || !predictors || predictors.length === 0) {
      this.log("Need a target and at least one predictor", "orange");
      return;
    }

    this.stats.totalRuns++;
    this.stats.dataPoints += data.length * predictors.length;

    document.getElementById("current-var").textContent = isUploaded ? `${targetVar} (from file)` : targetVar;
    document.getElementById("variables-analyzed").textContent = (this.stats.totalRuns * predictors.length).toString();

    if (analysisType === "linear") {
      await this.runLinearRegression(data, predictors[0], targetVar);
    } else {
      await this.runLogisticRegression(data, predictors.slice(0, AUTOSTAT_CONFIG.logistic.maxPredictorsPerRun), targetVar);
    }

    if (typeof playPing === "function") playPing();
    this.updateDashboard();
  }

  async runLinearRegression(data, predictor, target) {
    const { X, y } = this.buildMatrixAndVector(data, [predictor], target);
    if (X.length < 3) {
      this.log("Linear: not enough clean rows after filtering missing values", "orange");
      return;
    }
    const x1 = X.map((row) => row[0]);

    // LIVE math
    const result = await this.linearRegressionLive(x1, y);

    this.stats.linear.count++;
    this.stats.linear.r2Scores.push(result.r2);
    this.stats.linear.slopes.push(result.slope);
    this.stats.linear.bestR2 = Math.max(this.stats.linear.bestR2, result.r2);
    if (this.stats.linear.r2Scores.length > AUTOSTAT_CONFIG.chartWindow) this.stats.linear.r2Scores.shift();

    this.log(`Linear: ${predictor} → ${target} | R²=${fmt(result.r2, 4)} | slope=${fmt(result.slope, 4)}`, "blue");
    this.addResultCard("linear", predictor, target, result);
  }

  async runLogisticRegression(data, predictors, target) {
    const { X: Xraw, y: yRaw } = this.buildMatrixAndVector(data, predictors, target);
    if (Xraw.length < 8) {
      this.log("Logistic: not enough clean rows after filtering missing values", "orange");
      return;
    }

    const y = this.binarizeTarget(yRaw);
    let X = Xraw;
    if (AUTOSTAT_CONFIG.logistic.standardizeX) X = this.standardizeMatrix(Xraw).X;

    // LIVE math
    const result = await this.logisticRegressionLive(X, y);

    this.stats.logistic.count++;
    this.stats.logistic.accuracies.push(result.accuracy);
    this.stats.logistic.precisions.push(result.precision);
    this.stats.logistic.bestAcc = Math.max(this.stats.logistic.bestAcc, result.accuracy);
    if (this.stats.logistic.accuracies.length > AUTOSTAT_CONFIG.chartWindow) this.stats.logistic.accuracies.shift();

    this.log(`Logistic: [${predictors.join(", ")}] → ${target} | Acc=${fmt(result.accuracy, 4)} | Prec=${fmt(result.precision, 4)}`, "purple");
    this.addResultCard("logistic", predictors.join(", "), target, result);
  }

  // Used only for auto-mode fallback scoring (fast)
  simpleLinear(X, y) {
    const n = X.length;
    const sumX = safeSum(X);
    const sumY = safeSum(y);
    const sumXY = safeSumXY(X, y);
    const sumX2 = safeSumSq(X);

    const denom = (n * sumX2 - sumX * sumX);
    const slope = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;

    const preds = X.map((xi) => slope * xi + intercept);
    const mean = sumY / n;
    let ssT = 0, ssR = 0;
    for (let i = 0; i < n; i++) {
      const d = y[i] - mean; ssT += d * d;
      const r = y[i] - preds[i]; ssR += r * r;
    }
    const r2 = ssT === 0 ? 0 : 1 - ssR / ssT;
    return { slope, intercept, r2 };
  }

  logisticRegressionFast(X, y, iterations = 250, learningRate = 0.12) {
    const p = X[0].length;
    let weights = Array(p).fill(0);
    let bias = 0;
    const sigmoid = (z) => 1 / (1 + Math.exp(-clamp(z, -35, 35)));

    for (let iter = 0; iter < iterations; iter++) {
      let dw = Array(p).fill(0);
      let db = 0;

      for (let i = 0; i < X.length; i++) {
        const z = X[i].reduce((sum, xij, j) => sum + xij * weights[j], 0) + bias;
        const pred = sigmoid(z);
        const error = pred - y[i];

        for (let j = 0; j < p; j++) dw[j] += error * X[i][j];
        db += error;
      }

      for (let j = 0; j < p; j++) weights[j] -= (learningRate / X.length) * dw[j];
      bias -= (learningRate / X.length) * db;
    }

    const predictions = X.map((xi) => {
      const z = xi.reduce((sum, xij, j) => sum + xij * weights[j], 0) + bias;
      return sigmoid(z) > AUTOSTAT_CONFIG.logistic.threshold ? 1 : 0;
    });

    const accuracy = predictions.filter((pHat, i) => pHat === y[i]).length / y.length;
    const tp = predictions.filter((pHat, i) => pHat === 1 && y[i] === 1).length;
    const fp = predictions.filter((pHat, i) => pHat === 1 && y[i] === 0).length;
    const precision = tp / (tp + fp) || 0;

    return { accuracy, precision };
  }

  /* =========================
     UI helpers
     ========================= */
  addResultCard(type, predictor, target, result) {
    const container = document.getElementById("results-container");
    const card = document.createElement("div");
    card.className =
      "log-entry p-4 bg-gray-50 rounded-lg border-l-4 " +
      (type === "linear" ? "border-blue-500" : "border-purple-500");

    const isLinear = type === "linear";
    const title = isLinear ? "Linear Regression" : "Logistic Regression";
    const icon = isLinear ? "trending-up" : "binary";
    const colorClass = isLinear ? "text-blue-600" : "text-purple-600";

    card.innerHTML = `
      <div class="flex items-start justify-between">
        <div>
          <div class="flex items-center gap-2 mb-1">
            <i data-lucide="${icon}" class="w-4 h-4 ${colorClass}"></i>
            <span class="font-semibold ${colorClass}">${title}</span>
            <span class="text-xs text-gray-400">${new Date().toLocaleTimeString()}</span>
          </div>
          <p class="text-sm text-gray-700">
            <span class="font-mono bg-gray-200 px-1 rounded">${predictor}</span>
            →
            <span class="font-mono bg-gray-200 px-1 rounded">${target}</span>
          </p>
        </div>
        <div class="text-right">
          <div class="text-2xl font-bold ${colorClass}">
            ${isLinear ? fmt(result.r2, 3) : fmt(result.accuracy, 3)}
          </div>
          <div class="text-xs text-gray-500">${isLinear ? "R² Score" : "Accuracy"}</div>
        </div>
      </div>
      <div class="mt-2 grid grid-cols-3 gap-2 text-xs">
        ${
          isLinear
            ? `
              <div class="bg-white p-2 rounded">
                <div class="text-gray-500">Slope</div>
                <div class="font-mono font-semibold">${fmt(result.slope, 4)}</div>
              </div>
              <div class="bg-white p-2 rounded">
                <div class="text-gray-500">Intercept</div>
                <div class="font-mono font-semibold">${fmt(result.intercept, 4)}</div>
              </div>
              <div class="bg-white p-2 rounded">
                <div class="text-gray-500">Fit</div>
                <div class="font-mono font-semibold">${Number.isFinite(result.r2) ? (result.r2 > 0.7 ? "Strong" : result.r2 > 0.4 ? "Moderate" : "Weak") : "-"}</div>
              </div>
            `
            : `
              <div class="bg-white p-2 rounded">
                <div class="text-gray-500">Precision</div>
                <div class="font-mono font-semibold">${fmt(result.precision, 4)}</div>
              </div>
              <div class="bg-white p-2 rounded">
                <div class="text-gray-500">Weights</div>
                <div class="font-mono font-semibold">${result.weights ? result.weights.length : "-"}</div>
              </div>
              <div class="bg-white p-2 rounded">
                <div class="text-gray-500">Quality</div>
                <div class="font-mono font-semibold">${Number.isFinite(result.accuracy) ? (result.accuracy > 0.8 ? "Excellent" : result.accuracy > 0.6 ? "Good" : "Fair") : "-"}</div>
              </div>
            `
        }
      </div>
    `;

    container.insertBefore(card, container.firstChild);
    if (container.children.length > AUTOSTAT_CONFIG.maxResultsCards) container.removeChild(container.lastChild);
    lucide.createIcons();
  }

  log(message, color = "gray") {
    const container = document.getElementById("log-container");
    const entry = document.createElement("div");
    entry.className = `log-entry p-2 bg-${color}-50 rounded border-l-2 border-${color}-400`;

    const colors = {
      gray: "text-gray-600",
      blue: "text-blue-600",
      purple: "text-purple-600",
      green: "text-green-600",
      orange: "text-orange-600",
    };

    entry.innerHTML = `
      <span class="text-gray-400 text-xs">[${new Date().toLocaleTimeString()}]</span>
      <span class="${colors[color] || colors.gray}">${message}</span>
    `;

    container.insertBefore(entry, container.firstChild);
    if (container.children.length > AUTOSTAT_CONFIG.maxLogEntries) container.removeChild(container.lastChild);
  }

  updateDashboard() {
    document.getElementById("linear-count").textContent = this.stats.linear.count;
    const lastR2 = this.stats.linear.r2Scores[this.stats.linear.r2Scores.length - 1];
    document.getElementById("linear-r2").textContent = fmt(lastR2, 4);
    document.getElementById("linear-best-r2").textContent =
      Number.isFinite(this.stats.linear.bestR2) && this.stats.linear.bestR2 > -Infinity ? this.stats.linear.bestR2.toFixed(4) : "-";
    const avgSlope = this.stats.linear.slopes.length
      ? this.stats.linear.slopes.reduce((a, b) => a + b, 0) / this.stats.linear.slopes.length
      : NaN;
    document.getElementById("linear-slope").textContent = fmt(avgSlope, 4);

    document.getElementById("logistic-count").textContent = this.stats.logistic.count;
    const lastAcc = this.stats.logistic.accuracies[this.stats.logistic.accuracies.length - 1];
    document.getElementById("logistic-acc").textContent = fmt(lastAcc, 4);
    document.getElementById("logistic-best-acc").textContent = fmt(this.stats.logistic.bestAcc, 4);
    const avgPrec = this.stats.logistic.precisions.length
      ? this.stats.logistic.precisions.reduce((a, b) => a + b, 0) / this.stats.logistic.precisions.length
      : NaN;
    document.getElementById("logistic-precision").textContent = fmt(avgPrec, 4);

    document.getElementById("total-runs").textContent = this.stats.totalRuns;
    document.getElementById("data-points").textContent = this.stats.dataPoints.toLocaleString();

    this.linearChart.data.labels = this.stats.linear.r2Scores.map((_, i) => i);
    this.linearChart.data.datasets[0].data = this.stats.linear.r2Scores.map((v) => (Number.isFinite(v) ? v : 0));
    this.linearChart.update("none");

    this.logisticChart.data.labels = this.stats.logistic.accuracies.map((_, i) => i);
    this.logisticChart.data.datasets[0].data = this.stats.logistic.accuracies.map((v) => (Number.isFinite(v) ? v : 0));
    this.logisticChart.update("none");
  }

  updateProgressDisplay() {
    const progress = this.combinations.length > 0 ? (this.currentCombinationIndex / this.combinations.length) * 100 : 0;
    document.getElementById("progress-text").textContent = `${this.currentCombinationIndex} / ${this.combinations.length} completed`;
    document.getElementById("progress-bar").style.width = `${progress}%`;
  }

  start() {
    if (this.isRunning) return;

    const autoModeCheckbox = document.getElementById("auto-predictor-mode");
    this.isAutoMode = autoModeCheckbox && autoModeCheckbox.checked;

    if (this.isAutoMode) {
      this.startAutoMode();
      return;
    }

    this.isRunning = true;
    this.startTime = Date.now();

    document.getElementById("status-dot").classList.add("status-running");
    document.getElementById("status-text").textContent = "Running";
    document.getElementById("toggle-btn").innerHTML = '<i data-lucide="pause" class="w-4 h-4"></i><span>Pause</span>';
    lucide.createIcons();

    const interval = parseInt(document.getElementById("interval").value) * 1000;
    this.runAnalysis();
    this.intervalId = setInterval(() => this.runAnalysis(), interval);
    this.uptimeInterval = setInterval(() => this.updateUptime(), 1000);

    this.log("Agent started - continuous analysis enabled", "green");
  }

  stop() {
    if (!this.isRunning) return;

    this.isRunning = false;
    clearInterval(this.intervalId);
    clearInterval(this.uptimeInterval);

    document.getElementById("status-dot").classList.remove("status-running");
    document.getElementById("status-text").textContent = "Paused";
    document.getElementById("toggle-btn").innerHTML = '<i data-lucide="play" class="w-4 h-4"></i><span>Resume</span>';
    lucide.createIcons();

    this.log("Agent paused", "orange");
  }

  updateUptime() {
    if (!this.startTime) return;
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    const hours = Math.floor(elapsed / 3600).toString().padStart(2, "0");
    const minutes = Math.floor((elapsed % 3600) / 60).toString().padStart(2, "0");
    const seconds = (elapsed % 60).toString().padStart(2, "0");
    document.getElementById("uptime").textContent = `${hours}:${minutes}:${seconds}`;
  }
}

const agent = new StatisticalAgent();
function toggleAgent() {
  if (agent.isRunning) agent.stop();
  else agent.start();
}
