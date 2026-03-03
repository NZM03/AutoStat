// AutoStat AI Agent - Statistical Analysis Engine (PWA-ready + editable hooks)

const AUTOSTAT_CONFIG = {
  maxResultsCards: 10,
  maxLogEntries: 50,
  chartWindow: 50,

  linear: {
    requireNumericTarget: true,
  },

  logistic: {
    iterations: 1000,
    learningRate: 0.1,
    threshold: 0.5,
    binarizeMethod: "median", // "median" | "mean"
  },

  autoMode: {
    useMultipleLinearRegression: true, // uses simple-statistics if available
  },

  missing: {
    strategy: "drop", // only "drop" implemented
  },
};

const AUTOSTAT_HOOKS = {
  transformRow(rowObj) {
    return rowObj;
  },

  isNumericColumn(agent, columnName) {
    if (!agent.uploadedData || agent.uploadedData.length === 0) return true;

    let numericCount = 0;
    let totalCount = 0;

    for (const row of agent.uploadedData.slice(0, 10)) {
      const val = row[columnName];
      if (val !== undefined && val !== null && val !== "") {
        totalCount++;
        if (typeof val === "number" && !isNaN(val)) numericCount++;
      }
    }

    return totalCount > 0 && numericCount / totalCount > 0.5;
  },

  pickModelVariables({ isUploaded, variables, targetVar }) {
    if (isUploaded) {
      const actualTarget = targetVar || (variables.length ? variables[variables.length - 1] : null);
      const actualPredictors = variables
        .filter((v) => v !== actualTarget)
        .slice(0, Math.min(3, variables.length));
      return { actualTarget, actualPredictors };
    }

    // generated
    const actualTarget = variables[Math.floor(Math.random() * variables.length)];
    const actualPredictors = variables.filter((v) => v !== actualTarget).slice(0, Math.min(3, variables.length - 1));
    return { actualTarget, actualPredictors };
  },

  binarizeTarget(yRaw) {
    if (!yRaw.length) return [];
    if (AUTOSTAT_CONFIG.logistic.binarizeMethod === "mean") {
      const mean = yRaw.reduce((a, b) => a + b, 0) / yRaw.length;
      return yRaw.map((v) => (v > mean ? 1 : 0));
    }
    const sorted = [...yRaw].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return yRaw.map((v) => (v > median ? 1 : 0));
  },

  scoreCombination({ agent, data, predictors, target }) {
    // Preferred: multiple linear regression using simple-statistics, if available
    if (AUTOSTAT_CONFIG.autoMode.useMultipleLinearRegression && typeof ss !== "undefined" && typeof ss.multipleLinearRegression === "function") {
      const { X, y } = agent.buildMatrixAndVector(data, predictors, target);
      if (X.length < 3) return { r2: 0, intercept: 0, slope: 0, coefs: null };

      const rows = X.map((row, i) => [...row, y[i]]);
      const coefs = ss.multipleLinearRegression(rows); // [b0, b1, b2, ...]
      const preds = X.map((row) => coefs[0] + row.reduce((s, v, j) => s + v * coefs[j + 1], 0));
      const r2 = agent.computeR2(y, preds);

      return { r2, intercept: coefs[0], slope: coefs[1] ?? 0, coefs };
    }

    // Fallback: composite predictor average (still simple linear)
    let X1;
    if (predictors.length === 1) {
      X1 = data.map((d) => d[predictors[0]]);
    } else {
      X1 = data.map((d) => predictors.reduce((acc, p) => acc + (d[p] || 0), 0) / predictors.length);
    }
    const y1 = data.map((d) => d[target]);
    const result = agent.linearRegression(X1, y1);
    return { r2: result.r2, intercept: result.intercept, slope: result.slope, coefs: null };
  },
};

class StatisticalAgent {
  constructor() {
    this.isRunning = false;
    this.intervalId = null;
    this.uptimeInterval = null;
    this.startTime = null;

    this.stats = {
      linear: { count: 0, r2Scores: [], bestR2: 0, slopes: [] },
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
    this.initFileUpload();
  }

  computeR2(y, yhat) {
    const n = y.length;
    const mean = y.reduce((a, b) => a + b, 0) / n;
    const ssT = y.reduce((s, yi) => s + (yi - mean) ** 2, 0);
    const ssR = y.reduce((s, yi, i) => s + (yi - yhat[i]) ** 2, 0);
    return ssT === 0 ? 0 : 1 - ssR / ssT;
  }

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

      X.push(xs.map((v) => (typeof v === "number" ? v : (parseFloat(v) || 0))));
      y.push(typeof t === "number" ? t : (parseFloat(t) || 0));
    }

    return { X, y };
  }

  isNumericColumn(columnName) {
    return AUTOSTAT_HOOKS.isNumericColumn(this, columnName);
  }

  initFileUpload() {
    const fileInput = document.getElementById("excel-file");
    const uploadArea = document.getElementById("upload-area");

    uploadArea.addEventListener("click", (e) => {
      if (e.target !== fileInput) fileInput.click();
    });

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
      if (files.length > 0) this.handleFile(files[0]);
    });

    fileInput.addEventListener("change", (e) => {
      if (e.target.files.length > 0) this.handleFile(e.target.files[0]);
    });
  }

  handleFile(file) {
    if (!file.name.match(/\.(xlsx|xls)$/i)) {
      alert("Please upload an Excel file (.xlsx or .xls)");
      return;
    }

    document.getElementById("filename-display").textContent = file.name;

    const reader = new FileReader();
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

      if (hasValidData) data.push(AUTOSTAT_HOOKS.transformRow(rowData));
    }

    this.uploadedData = data;
    this.uploadedColumns = headers;

    const numericCount = headers.filter((h) => this.isNumericColumn(h)).length;
    document.getElementById("file-stats").textContent = `${data.length} rows × ${headers.length} columns | ${numericCount} numeric columns`;
    document.getElementById("file-info").classList.remove("hidden");

    this.populateVariableSelectors(headers);
    document.getElementById("variable-selection").classList.remove("hidden");
    this.showDataPreview(data, headers);

    this.log(`Parsed ${data.length} rows with ${headers.length} columns`, "green");
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

    // Auto-select first 3 numeric predictors
    const pickPreds = numericHeaders.slice(0, 3);
    for (const opt of predictorSelect.options) {
      opt.selected = pickPreds.includes(opt.value);
    }

    // Auto-select target as last numeric column
    if (numericHeaders.length > 0) {
      targetSelect.value = numericHeaders[numericHeaders.length - 1];
    }
  }

  showDataPreview(data, headers) {
    const previewContainer = document.getElementById("data-preview");
    const thead = document.getElementById("preview-header");
    const tbody = document.getElementById("preview-body");

    thead.innerHTML = "<tr>" + headers.map((h) => `<th class="px-3 py-2 text-left font-medium text-gray-700 border-b">${h}</th>`).join("") + "</tr>";

    tbody.innerHTML = data.slice(0, 5).map((row) =>
      "<tr class='border-b'>" + headers.map((h) => `<td class="px-3 py-2 text-gray-600 truncate max-w-xs">${row[h] ?? ""}</td>`).join("") + "</tr>"
    ).join("");

    previewContainer.classList.remove("hidden");
  }

  getDataForAnalysis(sampleSize) {
    const dataMode = document.getElementById("data-mode").value;

    // Mixed mode alternates if you have uploaded data
    if (dataMode === "mixed" && this.uploadedData) {
      this.stats.mixedFlip++;
      if (this.stats.mixedFlip % 2 === 1) {
        // generated half the time
        return this.generateData(sampleSize, 5);
      }
      // otherwise fall through to uploaded
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

    return {
      data,
      variables: effectivePredictors,
      targetVar: targetVar || (effectivePredictors.length ? effectivePredictors[effectivePredictors.length - 1] : null),
      isUploaded: true,
    };
  }

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

  initCharts() {
    const commonOptions = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { display: false }, y: { beginAtZero: true, max: 1 } },
      elements: { point: { radius: 0 }, line: { tension: 0.4 } },
    };

    this.linearChart = new Chart(document.getElementById("linear-chart"), {
      type: "line",
      data: {
        labels: [],
        datasets: [{
          data: [],
          borderColor: "#3b82f6",
          backgroundColor: "rgba(59, 130, 246, 0.1)",
          fill: true,
          borderWidth: 2,
        }],
      },
      options: commonOptions,
    });

    this.logisticChart = new Chart(document.getElementById("logistic-chart"), {
      type: "line",
      data: {
        labels: [],
        datasets: [{
          data: [],
          borderColor: "#8b5cf6",
          backgroundColor: "rgba(139, 92, 246, 0.1)",
          fill: true,
          borderWidth: 2,
        }],
      },
      options: commonOptions,
    });
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

    return { data, variables: selectedVars, isUploaded: false, targetVar: null };
  }

  linearRegression(X, y) {
    const n = X.length;
    const sumX = X.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = X.reduce((total, xi, i) => total + xi * y[i], 0);
    const sumX2 = X.reduce((total, xi) => total + xi * xi, 0);

    const denom = (n * sumX2 - sumX * sumX);
    const slope = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;

    const yMean = sumY / n;
    const ssTotal = y.reduce((total, yi) => total + (yi - yMean) ** 2, 0);
    const ssResidual = X.reduce((total, xi, i) => {
      const predicted = slope * xi + intercept;
      return total + (y[i] - predicted) ** 2;
    }, 0);

    const r2 = ssTotal === 0 ? 0 : 1 - (ssResidual / ssTotal);
    return { slope, intercept, r2, predictions: X.map((xi) => slope * xi + intercept) };
  }

  logisticRegression(X, y, iterations = AUTOSTAT_CONFIG.logistic.iterations, learningRate = AUTOSTAT_CONFIG.logistic.learningRate) {
    let weights = Array(X[0].length).fill(0);
    let bias = 0;

    const sigmoid = (z) => 1 / (1 + Math.exp(-z));

    for (let iter = 0; iter < iterations; iter++) {
      let dw = Array(X[0].length).fill(0);
      let db = 0;

      for (let i = 0; i < X.length; i++) {
        const z = X[i].reduce((sum, xij, j) => sum + xij * weights[j], 0) + bias;
        const pred = sigmoid(z);
        const error = pred - y[i];

        for (let j = 0; j < weights.length; j++) dw[j] += error * X[i][j];
        db += error;
      }

      for (let j = 0; j < weights.length; j++) weights[j] -= (learningRate / X.length) * dw[j];
      bias -= (learningRate / X.length) * db;
    }

    const predictions = X.map((xi) => {
      const z = xi.reduce((sum, xij, j) => sum + xij * weights[j], 0) + bias;
      return sigmoid(z) > AUTOSTAT_CONFIG.logistic.threshold ? 1 : 0;
    });

    const accuracy = predictions.filter((p, i) => p === y[i]).length / y.length;
    const truePos = predictions.filter((p, i) => p === 1 && y[i] === 1).length;
    const falsePos = predictions.filter((p, i) => p === 1 && y[i] === 0).length;
    const precision = truePos / (truePos + falsePos) || 0;

    return { weights, bias, accuracy, precision, predictions };
  }

  async runAnalysis() {
    const sampleSize = parseInt(document.getElementById("sample-size").value);
    const analysisType = document.getElementById("analysis-type").value;

    const dataInfo = this.getDataForAnalysis(sampleSize);
    const { data, variables, targetVar, isUploaded } = dataInfo;

    const numVars = variables.length || 1;
    this.stats.dataPoints += data.length * numVars;
    this.stats.totalRuns++;

    const { actualTarget, actualPredictors } = AUTOSTAT_HOOKS.pickModelVariables({
      isUploaded,
      variables,
      targetVar,
    });

    if (!actualTarget || !actualPredictors || actualPredictors.length === 0) {
      this.log("Need a target and at least one predictor", "orange");
      return;
    }

    document.getElementById("current-var").textContent = isUploaded ? `${actualTarget} (from file)` : actualTarget;
    document.getElementById("variables-analyzed").textContent = (this.stats.totalRuns * numVars).toString();

    if (analysisType === "both" || analysisType === "linear") {
      if (!isUploaded || !AUTOSTAT_CONFIG.linear.requireNumericTarget || this.isNumericColumn(actualTarget)) {
        await this.runLinearRegression(data, actualPredictors[0], actualTarget);
      }
    }

    if (analysisType === "both" || analysisType === "logistic") {
      await this.runLogisticRegression(data, actualPredictors, actualTarget);
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
    const result = this.linearRegression(x1, y);

    this.stats.linear.count++;
    this.stats.linear.r2Scores.push(result.r2);
    this.stats.linear.slopes.push(result.slope);
    if (result.r2 > this.stats.linear.bestR2) this.stats.linear.bestR2 = result.r2;

    if (this.stats.linear.r2Scores.length > AUTOSTAT_CONFIG.chartWindow) this.stats.linear.r2Scores.shift();

    this.log(`Linear: ${predictor} → ${target} | R²=${result.r2.toFixed(4)} | slope=${result.slope.toFixed(4)}`, "blue");
    this.addResultCard("linear", predictor, target, result);
  }

  async runLogisticRegression(data, predictors, target) {
    const { X, y: yRaw } = this.buildMatrixAndVector(data, predictors, target);
    if (X.length < 5) {
      this.log("Logistic: not enough clean rows after filtering missing values", "orange");
      return;
    }

    const y = AUTOSTAT_HOOKS.binarizeTarget(yRaw);
    const result = this.logisticRegression(X, y);

    this.stats.logistic.count++;
    this.stats.logistic.accuracies.push(result.accuracy);
    this.stats.logistic.precisions.push(result.precision);
    if (result.accuracy > this.stats.logistic.bestAcc) this.stats.logistic.bestAcc = result.accuracy;

    if (this.stats.logistic.accuracies.length > AUTOSTAT_CONFIG.chartWindow) this.stats.logistic.accuracies.shift();

    this.log(`Logistic: [${predictors.join(", ")}] → ${target} | Acc=${result.accuracy.toFixed(4)} | Prec=${result.precision.toFixed(4)}`, "purple");
    this.addResultCard("logistic", predictors.join(", "), target, result);
  }

  addResultCard(type, predictor, target, result) {
    const container = document.getElementById("results-container");
    const card = document.createElement("div");
    card.className = "log-entry p-4 bg-gray-50 rounded-lg border-l-4 " + (type === "linear" ? "border-blue-500" : "border-purple-500");

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
            ${isLinear ? result.r2.toFixed(3) : result.accuracy.toFixed(3)}
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
                <div class="font-mono font-semibold">${result.slope.toFixed(4)}</div>
              </div>
              <div class="bg-white p-2 rounded">
                <div class="text-gray-500">Intercept</div>
                <div class="font-mono font-semibold">${result.intercept.toFixed(4)}</div>
              </div>
              <div class="bg-white p-2 rounded">
                <div class="text-gray-500">Fit</div>
                <div class="font-mono font-semibold">${result.r2 > 0.7 ? "Strong" : result.r2 > 0.4 ? "Moderate" : "Weak"}</div>
              </div>
            `
            : `
              <div class="bg-white p-2 rounded">
                <div class="text-gray-500">Precision</div>
                <div class="font-mono font-semibold">${result.precision.toFixed(4)}</div>
              </div>
              <div class="bg-white p-2 rounded">
                <div class="text-gray-500">Weights</div>
                <div class="font-mono font-semibold">${result.weights.length}</div>
              </div>
              <div class="bg-white p-2 rounded">
                <div class="text-gray-500">Quality</div>
                <div class="font-mono font-semibold">${result.accuracy > 0.8 ? "Excellent" : result.accuracy > 0.6 ? "Good" : "Fair"}</div>
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
    const lastR2 = this.stats.linear.r2Scores[this.stats.linear.r2Scores.length - 1] || 0;
    document.getElementById("linear-r2").textContent = lastR2.toFixed(4);
    document.getElementById("linear-best-r2").textContent = this.stats.linear.bestR2.toFixed(4);
    const avgSlope = this.stats.linear.slopes.reduce((a, b) => a + b, 0) / (this.stats.linear.slopes.length || 1);
    document.getElementById("linear-slope").textContent = avgSlope.toFixed(4);

    document.getElementById("logistic-count").textContent = this.stats.logistic.count;
    const lastAcc = this.stats.logistic.accuracies[this.stats.logistic.accuracies.length - 1] || 0;
    document.getElementById("logistic-acc").textContent = lastAcc.toFixed(4);
    document.getElementById("logistic-best-acc").textContent = this.stats.logistic.bestAcc.toFixed(4);
    const avgPrec = this.stats.logistic.precisions.reduce((a, b) => a + b, 0) / (this.stats.logistic.precisions.length || 1);
    document.getElementById("logistic-precision").textContent = avgPrec.toFixed(4);

    document.getElementById("total-runs").textContent = this.stats.totalRuns;
    document.getElementById("data-points").textContent = this.stats.dataPoints.toLocaleString();

    this.linearChart.data.labels = this.stats.linear.r2Scores.map((_, i) => i);
    this.linearChart.data.datasets[0].data = this.stats.linear.r2Scores;
    this.linearChart.update("none");

    this.logisticChart.data.labels = this.stats.logistic.accuracies.map((_, i) => i);
    this.logisticChart.data.datasets[0].data = this.stats.logistic.accuracies;
    this.logisticChart.update("none");
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

  async runAutoCombination() {
    if (this.currentCombinationIndex >= this.combinations.length) {
      this.completeAutoMode();
      return;
    }

    const predictors = this.combinations[this.currentCombinationIndex];
    const sampleSize = parseInt(document.getElementById("sample-size").value);

    document.getElementById("current-combination").textContent = `Testing: ${predictors.join(" + ")}`;

    const dataInfo = this.getDataForAnalysis(sampleSize);
    const { data } = dataInfo;

    const scored = AUTOSTAT_HOOKS.scoreCombination({
      agent: this,
      data,
      predictors,
      target: this.targetVariable,
    });

    this.combinationResults.push({
      predictors,
      target: this.targetVariable,
      score: scored.r2,
      intercept: scored.intercept,
      slope: scored.slope,
      coefs: scored.coefs,
      type: "linear",
    });

    if (typeof playPing === "function") playPing();

    // keep stats moving
    this.stats.linear.count++;
    this.stats.linear.r2Scores.push(scored.r2);
    this.stats.linear.slopes.push(scored.slope);
    if (scored.r2 > this.stats.linear.bestR2) this.stats.linear.bestR2 = scored.r2;
    if (this.stats.linear.r2Scores.length > AUTOSTAT_CONFIG.chartWindow) this.stats.linear.r2Scores.shift();
    this.stats.totalRuns++;
    this.stats.dataPoints += data.length * predictors.length;

    this.currentCombinationIndex++;
    this.updateProgressDisplay();
    this.updateDashboard();

    this.log(`Combination ${this.currentCombinationIndex}/${this.combinations.length}: [${predictors.join(", ")}] → R²=${scored.r2.toFixed(4)}`, "blue");
  }

  updateProgressDisplay() {
    const progress = this.combinations.length > 0 ? (this.currentCombinationIndex / this.combinations.length) * 100 : 0;
    document.getElementById("progress-text").textContent = `${this.currentCombinationIndex} / ${this.combinations.length} completed`;
    document.getElementById("progress-bar").style.width = `${progress}%`;
  }

  completeAutoMode() {
    this.stop();

    if (typeof playPing === "function") {
      setTimeout(playPing, 200);
      setTimeout(playPing, 400);
    }

    const sorted = [...this.combinationResults].sort((a, b) => b.score - a.score);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];

    document.getElementById("best-model").textContent = `${best.predictors.join(" + ")} → ${best.target}`;
    document.getElementById("best-model-score").textContent = `R² = ${best.score.toFixed(4)}`;

    document.getElementById("worst-model").textContent = `${worst.predictors.join(" + ")} → ${worst.target}`;
    document.getElementById("worst-model-score").textContent = `R² = ${worst.score.toFixed(4)}`;

    document.getElementById("combination-results").classList.remove("hidden");
    document.getElementById("combination-progress").classList.add("hidden");

    this.createComparisonChart(sorted);

    this.log(`Auto mode complete! Best: R²=${best.score.toFixed(4)}, Worst: R²=${worst.score.toFixed(4)}`, "green");

    document.getElementById("status-text").textContent = "Complete";
    document.getElementById("status-dot").classList.remove("status-running");
    document.getElementById("toggle-btn").innerHTML = '<i data-lucide="play" class="w-4 h-4"></i><span>Start New Analysis</span>';
    lucide.createIcons();

    this.isAutoMode = false;
    this.currentCombinationIndex = 0;
  }

  createComparisonChart(sortedResults) {
    if (this.comparisonChart) this.comparisonChart.destroy();

    const ctx = document.getElementById("comparison-chart").getContext("2d");

    this.comparisonChart = new Chart(ctx, {
      type: "bar",
      data: {
        labels: sortedResults.map((_, i) => `#${i + 1}`),
        datasets: [{
          label: "R² Score",
          data: sortedResults.map((r) => r.score),
          backgroundColor: sortedResults.map((_, i) =>
            i === 0 ? "#10b981" : i === sortedResults.length - 1 ? "#ef4444" : "#6b7280"
          ),
          borderColor: sortedResults.map((_, i) =>
            i === 0 ? "#059669" : i === sortedResults.length - 1 ? "#dc2626" : "#4b5563"
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
              label: (item) => `R² = ${item.raw.toFixed(4)}`,
            },
          },
        },
        scales: {
          y: { beginAtZero: true, max: 1, title: { display: true, text: "R² Score" } },
          x: { title: { display: true, text: "Model Rank" } },
        },
      },
    });
  }

  stop() {
    if (!this.isRunning) return;

    this.isRunning = false;
    clearInterval(this.intervalId);
    clearInterval(this.uptimeInterval);

    document.getElementById("status-dot").classList.remove("status-running");

    if (this.isAutoMode && this.currentCombinationIndex < this.combinations.length) {
      document.getElementById("status-text").textContent = "Stopped";
      document.getElementById("combination-progress").classList.add("hidden");
      this.log("Auto mode stopped by user", "orange");
      this.isAutoMode = false;
      this.currentCombinationIndex = 0;
    } else {
      document.getElementById("status-text").textContent = "Paused";
    }

    document.getElementById("toggle-btn").innerHTML = '<i data-lucide="play" class="w-4 h-4"></i><span>Resume</span>';
    lucide.createIcons();

    if (!this.isAutoMode) this.log("Agent paused", "orange");
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

// Global agent instance
const agent = new StatisticalAgent();

function toggleAgent() {
  if (agent.isRunning) agent.stop();
  else agent.start();
}
