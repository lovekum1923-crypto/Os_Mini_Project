/**
 * Smart Job Scheduling System - Frontend Controller & WebAssembly Bridge
 * Communicates directly with scheduler.c compiled via Emscripten.
 */

(function () {
  "use strict";

  /* ------------------------------------------------------------------------
     1. Application State & Constants
  ------------------------------------------------------------------------ */
  const ALGO_NAMES = {
    1: "First Come First Serve (FCFS)",
    2: "Shortest Job First (SJF)",
    3: "Priority Scheduling (1 = Highest)",
    4: "Round Robin (RR)"
  };

  const JOB_COLORS = [
    "#3b82f6", "#10b981", "#8b5cf6", "#f59e0b",
    "#ec4899", "#06b6d4", "#6366f1", "#14b8a6",
    "#f97316", "#84cc16"
  ];

  const DEFAULT_JOBS = [
    { id: 1, name: "Kernel Boot Sync",    arrival: 0, burst: 5, priority: 2, deadline: 10 },
    { id: 2, name: "Database Backup",     arrival: 1, burst: 3, priority: 1, deadline: 6 },
    { id: 3, name: "Analytics Batch",     arrival: 2, burst: 8, priority: 4, deadline: 22 },
    { id: 4, name: "API Gateway Flush",   arrival: 4, burst: 2, priority: 1, deadline: 9 },
    { id: 5, name: "Log Compression",     arrival: 6, burst: 4, priority: 3, deadline: 18 }
  ];

  let jobs = JSON.parse(JSON.stringify(DEFAULT_JOBS));
  let activeAlgo = 1;
  let timeQuantum = 2;
  let wasmReady = false;

  // Latest results returned by the C WebAssembly engine
  let lastScheduleResult = {
    algoId: 1,
    scheduledJobs: [],
    ganttBlocks: [],
    metrics: {
      avgWaitingTime: 0,
      avgTurnaroundTime: 0,
      avgResponseTime: 0,
      cpuUtilization: 0
    }
  };

  let timeChartInstance = null;
  let utilChartInstance = null;

  /* ------------------------------------------------------------------------
     2. Scheduling Engine (JS fallback + optional C/WASM bridge)
  ------------------------------------------------------------------------ */
  let useJsFallback = false;

  function initWasmBridge() {
    const dot = document.getElementById("wasm-dot");
    const statusText = document.getElementById("wasm-status-text");

    function onWasmInitialized() {
      wasmReady = true;
      useJsFallback = false;
      dot.className = "status-dot ready";
      statusText.textContent = "C WASM Engine Ready";
      executeCurrentSchedule();
    }

    function enableJsFallback(reason) {
      wasmReady = true;
      useJsFallback = true;
      dot.className = "status-dot ready";
      statusText.textContent = "JS Engine Ready";
      console.info("Scheduler fallback:", reason);
      executeCurrentSchedule();
    }

    if (typeof Module !== "undefined" && Module._run_scheduler) {
      onWasmInitialized();
      return;
    }

    if (typeof Module !== "undefined") {
      const prevCallback = Module.onRuntimeInitialized;
      Module.onRuntimeInitialized = function () {
        if (typeof prevCallback === "function") prevCallback();
        if (Module._run_scheduler) onWasmInitialized();
        else enableJsFallback("WASM module loaded without run_scheduler export.");
      };
      setTimeout(function () {
        if (!wasmReady) enableJsFallback("WASM runtime did not initialize in time.");
      }, 1500);
      return;
    }

    enableJsFallback("scheduler.js/WASM not found; using built-in JS scheduler.");
  }

  function addGanttBlock(gantt, jobId, start, end) {
    if (start >= end) return;
    const last = gantt[gantt.length - 1];
    if (last && last.jobId === jobId && last.end === start) {
      last.end = end;
      last.duration = end - last.start;
      return;
    }
    gantt.push({ jobId: jobId, start: start, end: end, duration: end - start });
  }

  function cloneJobsForSchedule(jobList) {
    return jobList.map(function (j) {
      return {
        id: j.id, name: j.name, arrival: j.arrival, burst: j.burst,
        priority: j.priority, deadline: j.deadline,
        completion: 0, turnaround: 0, waiting: 0, response: -1,
        remaining: j.burst, done: false, firstStart: -1, inQueue: false
      };
    });
  }

  function finalizeMetrics(jobsOut, gantt) {
    let totalWt = 0, totalTat = 0, totalRt = 0, totalBurst = 0, maxCompletion = 0;
    for (let i = 0; i < jobsOut.length; i++) {
      const j = jobsOut[i];
      totalWt += j.waiting;
      totalTat += j.turnaround;
      totalRt += j.response;
      totalBurst += j.burst;
      if (j.completion > maxCompletion) maxCompletion = j.completion;
    }
    const n = jobsOut.length || 1;
    const elapsed = maxCompletion > 0 ? maxCompletion : 1;
    return {
      avgWaitingTime: totalWt / n,
      avgTurnaroundTime: totalTat / n,
      avgResponseTime: totalRt / n,
      cpuUtilization: (totalBurst / elapsed) * 100
    };
  }

  function scheduleFCFS_JS(jobList) {
    const jobsArr = cloneJobsForSchedule(jobList);
    const gantt = [];
    let completed = 0;
    let currentTime = 0;
    while (completed < jobsArr.length) {
      let idx = -1;
      let earliest = Infinity;
      for (let i = 0; i < jobsArr.length; i++) {
        if (jobsArr[i].done) continue;
        const j = jobsArr[i];
        if (j.arrival < earliest || (j.arrival === earliest && (idx === -1 || j.id < jobsArr[idx].id))) {
          earliest = j.arrival;
          idx = i;
        }
      }
      if (idx === -1) break;
      if (jobsArr[idx].arrival > currentTime) {
        addGanttBlock(gantt, -1, currentTime, jobsArr[idx].arrival);
        currentTime = jobsArr[idx].arrival;
      }
      const start = currentTime;
      const end = start + jobsArr[idx].burst;
      addGanttBlock(gantt, jobsArr[idx].id, start, end);
      jobsArr[idx].completion = end;
      jobsArr[idx].turnaround = end - jobsArr[idx].arrival;
      jobsArr[idx].waiting = jobsArr[idx].turnaround - jobsArr[idx].burst;
      jobsArr[idx].response = start - jobsArr[idx].arrival;
      jobsArr[idx].done = true;
      completed++;
      currentTime = end;
    }
    return { jobsArr: jobsArr, gantt: gantt };
  }

  function scheduleSJF_JS(jobList) {
    const jobsArr = cloneJobsForSchedule(jobList);
    const gantt = [];
    let completed = 0;
    let currentTime = 0;
    while (completed < jobsArr.length) {
      let idx = -1;
      for (let i = 0; i < jobsArr.length; i++) {
        const j = jobsArr[i];
        if (j.done || j.arrival > currentTime) continue;
        if (idx === -1) { idx = i; continue; }
        const b = jobsArr[idx];
        if (j.burst < b.burst ||
            (j.burst === b.burst && j.arrival < b.arrival) ||
            (j.burst === b.burst && j.arrival === b.arrival && j.id < b.id)) {
          idx = i;
        }
      }
      if (idx === -1) {
        let nextArrival = Infinity;
        for (let i = 0; i < jobsArr.length; i++) {
          if (!jobsArr[i].done && jobsArr[i].arrival < nextArrival) nextArrival = jobsArr[i].arrival;
        }
        if (nextArrival === Infinity) break;
        addGanttBlock(gantt, -1, currentTime, nextArrival);
        currentTime = nextArrival;
        continue;
      }
      const start = currentTime;
      const end = start + jobsArr[idx].burst;
      addGanttBlock(gantt, jobsArr[idx].id, start, end);
      jobsArr[idx].completion = end;
      jobsArr[idx].turnaround = end - jobsArr[idx].arrival;
      jobsArr[idx].waiting = jobsArr[idx].turnaround - jobsArr[idx].burst;
      jobsArr[idx].response = start - jobsArr[idx].arrival;
      jobsArr[idx].done = true;
      completed++;
      currentTime = end;
    }
    return { jobsArr: jobsArr, gantt: gantt };
  }

  function schedulePriority_JS(jobList) {
    const jobsArr = cloneJobsForSchedule(jobList);
    const gantt = [];
    let completed = 0;
    let currentTime = 0;
    while (completed < jobsArr.length) {
      let idx = -1;
      for (let i = 0; i < jobsArr.length; i++) {
        const j = jobsArr[i];
        if (j.done || j.arrival > currentTime) continue;
        if (idx === -1) { idx = i; continue; }
        const b = jobsArr[idx];
        if (j.priority < b.priority ||
            (j.priority === b.priority && j.arrival < b.arrival) ||
            (j.priority === b.priority && j.arrival === b.arrival && j.id < b.id)) {
          idx = i;
        }
      }
      if (idx === -1) {
        let nextArrival = Infinity;
        for (let i = 0; i < jobsArr.length; i++) {
          if (!jobsArr[i].done && jobsArr[i].arrival < nextArrival) nextArrival = jobsArr[i].arrival;
        }
        if (nextArrival === Infinity) break;
        addGanttBlock(gantt, -1, currentTime, nextArrival);
        currentTime = nextArrival;
        continue;
      }
      const start = currentTime;
      const end = start + jobsArr[idx].burst;
      addGanttBlock(gantt, jobsArr[idx].id, start, end);
      jobsArr[idx].completion = end;
      jobsArr[idx].turnaround = end - jobsArr[idx].arrival;
      jobsArr[idx].waiting = jobsArr[idx].turnaround - jobsArr[idx].burst;
      jobsArr[idx].response = start - jobsArr[idx].arrival;
      jobsArr[idx].done = true;
      completed++;
      currentTime = end;
    }
    return { jobsArr: jobsArr, gantt: gantt };
  }

  function scheduleRR_JS(jobList, quantum) {
    const q = Math.max(1, Number(quantum) || 1);
    const jobsArr = cloneJobsForSchedule(jobList);
    const gantt = [];
    const n = jobsArr.length;
    const order = jobsArr.map(function (_, i) { return i; }).sort(function (a, b) {
      if (jobsArr[a].arrival !== jobsArr[b].arrival) return jobsArr[a].arrival - jobsArr[b].arrival;
      return jobsArr[a].id - jobsArr[b].id;
    });
    let completed = 0;
    let currentTime = 0;
    const queue = [];
    function enqueueArrivals(upToTime, excludeIdx) {
      for (let k = 0; k < order.length; k++) {
        const i = order[k];
        if (i === excludeIdx) continue;
        const j = jobsArr[i];
        if (j.remaining > 0 && j.arrival <= upToTime && !j.inQueue) {
          queue.push(i);
          j.inQueue = true;
        }
      }
    }

    if (n > 0 && jobsArr[order[0]].arrival > 0) {
      addGanttBlock(gantt, -1, 0, jobsArr[order[0]].arrival);
      currentTime = jobsArr[order[0]].arrival;
    }
    enqueueArrivals(currentTime);

    while (completed < n) {
      if (queue.length === 0) {
        let nextArrival = Infinity;
        for (let i = 0; i < n; i++) {
          if (jobsArr[i].remaining > 0 && jobsArr[i].arrival < nextArrival) nextArrival = jobsArr[i].arrival;
        }
        if (nextArrival === Infinity) break;
        if (nextArrival > currentTime) {
          addGanttBlock(gantt, -1, currentTime, nextArrival);
          currentTime = nextArrival;
        }
        enqueueArrivals(currentTime);
        if (queue.length === 0) { currentTime++; continue; }
      }

      const idx = queue.shift();
      jobsArr[idx].inQueue = false;
      if (jobsArr[idx].remaining <= 0) continue;
      if (jobsArr[idx].firstStart === -1) jobsArr[idx].firstStart = currentTime;

      const exec = Math.min(q, jobsArr[idx].remaining);
      const start = currentTime;
      const end = start + exec;
      addGanttBlock(gantt, jobsArr[idx].id, start, end);
      jobsArr[idx].remaining -= exec;
      currentTime = end;

      enqueueArrivals(currentTime, idx);
      if (jobsArr[idx].remaining > 0) {
        queue.push(idx);
        jobsArr[idx].inQueue = true;
      } else {
        completed++;
        jobsArr[idx].completion = currentTime;
        jobsArr[idx].turnaround = jobsArr[idx].completion - jobsArr[idx].arrival;
        jobsArr[idx].waiting = jobsArr[idx].turnaround - jobsArr[idx].burst;
        jobsArr[idx].response = jobsArr[idx].firstStart - jobsArr[idx].arrival;
        jobsArr[idx].done = true;
      }
    }
    return { jobsArr: jobsArr, gantt: gantt };
  }

  function runSchedulerJS(algoId, jobList, quantum) {
    const n = jobList.length;
    if (n === 0) {
      return { algoId: algoId, scheduledJobs: [], ganttBlocks: [], metrics: { avgWaitingTime: 0, avgTurnaroundTime: 0, avgResponseTime: 0, cpuUtilization: 0 } };
    }
    let out;
    if (algoId === 1) out = scheduleFCFS_JS(jobList);
    else if (algoId === 2) out = scheduleSJF_JS(jobList);
    else if (algoId === 3) out = schedulePriority_JS(jobList);
    else if (algoId === 4) out = scheduleRR_JS(jobList, quantum);
    else return null;

    const byId = new Map(jobList.map(function (j) { return [j.id, j.name]; }));
    const scheduledJobs = out.jobsArr.map(function (j) {
      return {
        id: j.id, name: j.name, arrival: j.arrival, burst: j.burst,
        priority: j.priority, deadline: j.deadline,
        completion: j.completion, turnaround: j.turnaround, waiting: j.waiting, response: j.response
      };
    });
    const ganttBlocks = out.gantt.map(function (b) {
      return {
        jobId: b.jobId,
        jobName: b.jobId === -1 ? "CPU IDLE" : (byId.get(b.jobId) || ("Job #" + b.jobId)),
        start: b.start, end: b.end, duration: b.duration
      };
    });
    return { algoId: algoId, scheduledJobs: scheduledJobs, ganttBlocks: ganttBlocks, metrics: finalizeMetrics(out.jobsArr, out.gantt) };
  }

  function invokeCScheduler(algoId, jobList, quantum) {
    const n = jobList.length;
    if (n === 0) {
      return { algoId: algoId, scheduledJobs: [], ganttBlocks: [], metrics: { avgWaitingTime: 0, avgTurnaroundTime: 0, avgResponseTime: 0, cpuUtilization: 0 } };
    }

    if (!useJsFallback && wasmReady && typeof Module !== "undefined" && Module._run_scheduler) {
      const JOB_INTS = 9;
      const JOB_BYTES = JOB_INTS * 4;
      const MAX_GANTT = 1000;
      const GANTT_INTS = 4;
      const GANTT_BYTES = MAX_GANTT * GANTT_INTS * 4;
      const METRICS_BYTES = 4 * 4;

      const jobsPtr = Module._malloc(n * JOB_BYTES);
      const ganttPtr = Module._malloc(GANTT_BYTES);
      const metricsPtr = Module._malloc(METRICS_BYTES);

      try {
        for (let i = 0; i < n; i++) {
          const base = (jobsPtr >> 2) + i * JOB_INTS;
          Module.HEAP32[base + 0] = jobList[i].id;
          Module.HEAP32[base + 1] = jobList[i].arrival;
          Module.HEAP32[base + 2] = jobList[i].burst;
          Module.HEAP32[base + 3] = jobList[i].priority;
          Module.HEAP32[base + 4] = jobList[i].deadline;
          Module.HEAP32[base + 5] = 0;
          Module.HEAP32[base + 6] = 0;
          Module.HEAP32[base + 7] = 0;
          Module.HEAP32[base + 8] = 0;
        }

        const ganttCount = Module._run_scheduler(algoId, n, quantum, jobsPtr, ganttPtr, metricsPtr);
        if (ganttCount < 0) throw new Error("C scheduler returned an error code.");

        const scheduledJobs = [];
        for (let i = 0; i < n; i++) {
          const base = (jobsPtr >> 2) + i * JOB_INTS;
          scheduledJobs.push({
            id: Module.HEAP32[base + 0],
            name: jobList[i].name,
            arrival: Module.HEAP32[base + 1],
            burst: Module.HEAP32[base + 2],
            priority: Module.HEAP32[base + 3],
            deadline: Module.HEAP32[base + 4],
            completion: Module.HEAP32[base + 5],
            turnaround: Module.HEAP32[base + 6],
            waiting: Module.HEAP32[base + 7],
            response: Module.HEAP32[base + 8]
          });
        }

        const ganttBlocks = [];
        for (let i = 0; i < ganttCount; i++) {
          const base = (ganttPtr >> 2) + i * GANTT_INTS;
          const jobId = Module.HEAP32[base + 0];
          const foundJob = jobList.find(function (j) { return j.id === jobId; });
          ganttBlocks.push({
            jobId: jobId,
            jobName: jobId === -1 ? "CPU IDLE" : (foundJob ? foundJob.name : "Job #" + jobId),
            start: Module.HEAP32[base + 1],
            end: Module.HEAP32[base + 2],
            duration: Module.HEAP32[base + 3]
          });
        }

        const mBase = metricsPtr >> 2;
        return {
          algoId: algoId,
          scheduledJobs: scheduledJobs,
          ganttBlocks: ganttBlocks,
          metrics: {
            avgWaitingTime: Module.HEAPF32[mBase + 0],
            avgTurnaroundTime: Module.HEAPF32[mBase + 1],
            avgResponseTime: Module.HEAPF32[mBase + 2],
            cpuUtilization: Module.HEAPF32[mBase + 3]
          }
        };
      } catch (err) {
        console.warn("WASM scheduler failed, falling back to JS:", err);
        useJsFallback = true;
        const statusText = document.getElementById("wasm-status-text");
        if (statusText) statusText.textContent = "JS Engine Ready";
        return runSchedulerJS(algoId, jobList, quantum);
      } finally {
        Module._free(jobsPtr);
        Module._free(ganttPtr);
        Module._free(metricsPtr);
      }
    }

    return runSchedulerJS(algoId, jobList, quantum);
  }

  /* ------------------------------------------------------------------------
     3. Orchestrate Full C Execution & UI Refresh
  ------------------------------------------------------------------------ */
  function executeCurrentSchedule() {
    document.getElementById("nav-job-count").textContent = jobs.length;

    if (!wasmReady) {
      renderManageJobsTable();
      renderDashboardQuickTable([]);
      return;
    }

    const result = invokeCScheduler(activeAlgo, jobs, timeQuantum);
    if (!result) return;

    lastScheduleResult = result;

    updateDashboardKPIs(result);
    renderDashboardQuickTable(result.scheduledJobs);
    renderManageJobsTable();
    renderGanttCharts(result);
    renderPerformanceTable(result);
    runAllAlgorithmsBenchmark();
  }

  /* ------------------------------------------------------------------------
     4. Dashboard KPIs & Smart Scheduling Advisor
  ------------------------------------------------------------------------ */
  function updateDashboardKPIs(result) {
    const total = jobs.length;
    const completed = result.scheduledJobs.length;
    const pending = Math.max(0, total - completed);

    document.getElementById("kpi-total-jobs").textContent = total;
    document.getElementById("kpi-completed-jobs").textContent = completed;
    document.getElementById("kpi-pending-jobs").textContent = pending;
    document.getElementById("kpi-algo-label").textContent = ALGO_NAMES[result.algoId];

    document.getElementById("kpi-avg-wt").innerHTML = `${result.metrics.avgWaitingTime.toFixed(2)} <small>units</small>`;
    document.getElementById("kpi-avg-tat").innerHTML = `${result.metrics.avgTurnaroundTime.toFixed(2)} <small>units</small>`;
    document.getElementById("kpi-cpu-util").textContent = `${result.metrics.cpuUtilization.toFixed(1)}%`;
  }

  function updateSmartAdvisor(allBenchmarks) {
    const recBadge = document.getElementById("smart-rec-algo");
    const recReason = document.getElementById("smart-rec-reason");
    const deadlineList = document.getElementById("smart-deadline-list");

    if (jobs.length === 0 || !allBenchmarks || allBenchmarks.length === 0) {
      recBadge.textContent = "No Jobs in Queue";
      recReason.textContent = "Add jobs in the 'Add Jobs' section to evaluate workload suitability and deadline warnings.";
      deadlineList.innerHTML = `<p class="muted-text">No jobs available to analyze.</p>`;
      return;
    }

    // Analyze workload characteristics
    const bursts = jobs.map((j) => j.burst);
    const maxBurst = Math.max(...bursts);
    const minBurst = Math.min(...bursts);
    const priorities = new Set(jobs.map((j) => j.priority));

    // Pick lowest average waiting time from actual C benchmark results
    const sortedByWait = [...allBenchmarks].sort((a, b) => a.metrics.avgWaitingTime - b.metrics.avgWaitingTime);
    const best = sortedByWait[0];

    let rationale = `${ALGO_NAMES[best.algoId]} achieved the lowest average waiting time (${best.metrics.avgWaitingTime.toFixed(2)}) and turnaround time (${best.metrics.avgTurnaroundTime.toFixed(2)}) in C execution. `;

    if (maxBurst - minBurst >= 5) {
      rationale += `Because burst times vary widely (${minBurst} to ${maxBurst} units), non-preemptive SJF prevents long jobs from blocking short tasks (convoy effect).`;
    } else if (priorities.size > 1) {
      rationale += `Distinct priority levels (1 to ${Math.max(...priorities)}) are present; Priority Scheduling ensures critical tasks execute ahead of background jobs.`;
    } else {
      rationale += `Job bursts are relatively uniform, making Round Robin (Q=${timeQuantum}) or FCFS predictable and fair.`;
    }

    recBadge.textContent = ALGO_NAMES[best.algoId];
    recReason.textContent = rationale;

    // Deadline Health Check on Active Schedule
    const alerts = [];
    lastScheduleResult.scheduledJobs.forEach((job) => {
      const slack = job.deadline - job.completion;
      if (slack < 0) {
        alerts.push({
          type: "danger",
          text: `#${job.id} (${job.name}) — Missed deadline by ${Math.abs(slack)} units (Completed: ${job.completion}, Deadline: ${job.deadline})`
        });
      } else if (slack <= 2) {
        alerts.push({
          type: "warn",
          text: `#${job.id} (${job.name}) — Tight deadline margin (${slack} units remaining before deadline ${job.deadline})`
        });
      }
    });

    if (alerts.length === 0) {
      deadlineList.innerHTML = `<div class="deadline-item"><span class="status-pill ok">All Clear</span><span>All ${jobs.length} jobs completed safely within their target deadlines under ${ALGO_NAMES[activeAlgo]}.</span></div>`;
    } else {
      deadlineList.innerHTML = alerts
        .map(
          (a) => `
          <div class="deadline-item">
            <span>${escapeHtml(a.text)}</span>
            <span class="status-pill ${a.type}">${a.type === "danger" ? "MISSED" : "AT RISK"}</span>
          </div>`
        )
        .join("");
    }
  }

  /* ------------------------------------------------------------------------
     5. Gantt Chart Rendering (Driven strictly by C Engine GanttBlocks)
  ------------------------------------------------------------------------ */
  function getJobColor(jobId) {
    if (jobId === -1) return "#334155";
    return JOB_COLORS[Math.abs(jobId) % JOB_COLORS.length];
  }

  function renderGanttCharts(result) {
    const blocks = result.ganttBlocks;
    const targets = [
      { barId: "dashboard-gantt-preview", axisId: "dashboard-gantt-axis" },
      { barId: "full-gantt-bar", axisId: "full-gantt-axis" }
    ];

    document.getElementById("gantt-subtitle").textContent =
      `Algorithm: ${ALGO_NAMES[result.algoId]} | Total Slices: ${blocks.length}`;

    if (!blocks || blocks.length === 0) {
      targets.forEach((t) => {
        document.getElementById(t.barId).innerHTML = `<div style="padding:18px;color:var(--text-secondary);">No execution blocks yet. Add jobs and run the C scheduler.</div>`;
        document.getElementById(t.axisId).innerHTML = "";
      });
      document.getElementById("gantt-sequence-tbody").innerHTML = "";
      document.getElementById("gantt-legend").innerHTML = "";
      return;
    }

    const totalDuration = blocks[blocks.length - 1].end - blocks[0].start || 1;

    targets.forEach((target) => {
      const barEl = document.getElementById(target.barId);
      const axisEl = document.getElementById(target.axisId);

      barEl.innerHTML = "";
      axisEl.innerHTML = "";

      blocks.forEach((blk, idx) => {
        const widthPct = (blk.duration / totalDuration) * 100;
        const isIdle = blk.jobId === -1;

        const blockDiv = document.createElement("div");
        blockDiv.className = `gantt-block ${isIdle ? "idle" : ""}`;
        blockDiv.style.width = `${widthPct}%`;
        if (!isIdle) {
          blockDiv.style.backgroundColor = getJobColor(blk.jobId);
        }

        blockDiv.innerHTML = `
          <span>${isIdle ? "IDLE" : `J${blk.jobId}`}</span>
          <small>${blk.start}–${blk.end}</small>
        `;

        const inspectHandler = () => {
          document.getElementById("gantt-inspector").innerHTML = isIdle
            ? `<strong>CPU IDLE Period</strong> | Start Time: <strong>${blk.start}</strong> | End Time: <strong>${blk.end}</strong> | Idle Duration: <strong>${blk.duration}</strong> units`
            : `<strong>Job #${blk.jobId} (${escapeHtml(blk.jobName)})</strong> | Start Time: <strong>${blk.start}</strong> | End Time: <strong>${blk.end}</strong> | Execution Duration: <strong>${blk.duration}</strong> units`;
        };

        blockDiv.addEventListener("mouseenter", inspectHandler);
        blockDiv.addEventListener("click", inspectHandler);
        barEl.appendChild(blockDiv);

        // Timeline Tick Labels
        const tickDiv = document.createElement("div");
        tickDiv.className = "gantt-tick";
        tickDiv.style.width = `${widthPct}%`;
        tickDiv.innerHTML = `<span>${idx === 0 ? blk.start : ""}</span><span>${blk.end}</span>`;
        axisEl.appendChild(tickDiv);
      });
    });

    // Legend
    const legendEl = document.getElementById("gantt-legend");
    const uniqueJobs = [...new Map(jobs.map((j) => [j.id, j])).values()];
    legendEl.innerHTML =
      uniqueJobs
        .map(
          (j) => `<span class="legend-item"><span class="legend-swatch" style="background:${getJobColor(j.id)}"></span>J${j.id}: ${escapeHtml(j.name)}</span>`
        )
        .join("") +
      `<span class="legend-item"><span class="legend-swatch" style="background:#334155"></span>CPU Idle</span>`;

    // Sequence Table
    const seqTbody = document.getElementById("gantt-sequence-tbody");
    seqTbody.innerHTML = blocks
      .map(
        (b, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${b.jobId === -1 ? '<span class="status-pill warn">CPU IDLE</span>' : `<strong>J${b.jobId}</strong> — ${escapeHtml(b.jobName)}`}</td>
          <td>${b.start}</td>
          <td>${b.end}</td>
          <td>${b.duration} units</td>
        </tr>`
      )
      .join("");
  }

  /* ------------------------------------------------------------------------
     6. Performance Table & Multi-Algorithm Benchmark Charts
  ------------------------------------------------------------------------ */
  function renderPerformanceTable(result) {
    document.getElementById("perf-algo-heading").textContent =
      `Active Algorithm: ${ALGO_NAMES[result.algoId]} (Calculated in scheduler.c)`;

    const tbody = document.getElementById("performance-tbody");
    const tfoot = document.getElementById("performance-tfoot");

    if (result.scheduledJobs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="10" class="muted-text">No jobs scheduled.</td></tr>`;
      tfoot.innerHTML = "";
      return;
    }

    const sorted = [...result.scheduledJobs].sort((a, b) => a.id - b.id);

    tbody.innerHTML = sorted
      .map((j) => {
        const met = j.completion <= j.deadline;
        return `
          <tr>
            <td><strong>#${j.id}</strong></td>
            <td>${escapeHtml(j.name)}</td>
            <td>${j.arrival}</td>
            <td>${j.burst}</td>
            <td>${j.priority}</td>
            <td><strong>${j.completion}</strong></td>
            <td>${j.turnaround}</td>
            <td>${j.waiting}</td>
            <td>${j.response}</td>
            <td><span class="status-pill ${met ? "ok" : "danger"}">${met ? `Met (≤ ${j.deadline})` : `Missed (> ${j.deadline})`}</span></td>
          </tr>`;
      })
      .join("");

    tfoot.innerHTML = `
      <tr>
        <td colspan="6">Averages &amp; Utilization (C Engine Output)</td>
        <td>Avg TAT: ${result.metrics.avgTurnaroundTime.toFixed(2)}</td>
        <td>Avg WT: ${result.metrics.avgWaitingTime.toFixed(2)}</td>
        <td>Avg RT: ${result.metrics.avgResponseTime.toFixed(2)}</td>
        <td>CPU Util: ${result.metrics.cpuUtilization.toFixed(1)}%</td>
      </tr>`;
  }

  function runAllAlgorithmsBenchmark() {
    if (!wasmReady || jobs.length === 0) {
      document.getElementById("comparison-tbody").innerHTML =
        `<tr><td colspan="6" class="muted-text">Add jobs to benchmark all four C scheduling algorithms.</td></tr>`;
      updateSmartAdvisor([]);
      return;
    }

    const benchmarks = [1, 2, 3, 4].map((id) => invokeCScheduler(id, jobs, timeQuantum));
    updateSmartAdvisor(benchmarks);

    const tbody = document.getElementById("comparison-tbody");
    tbody.innerHTML = benchmarks
      .map((b) => {
        const metCount = b.scheduledJobs.filter((j) => j.completion <= j.deadline).length;
        const label = b.algoId === 4 ? `${ALGO_NAMES[b.algoId]} (Q=${timeQuantum})` : ALGO_NAMES[b.algoId];
        return `
          <tr>
            <td><strong>${label}</strong></td>
            <td>${b.metrics.avgWaitingTime.toFixed(2)}</td>
            <td>${b.metrics.avgTurnaroundTime.toFixed(2)}</td>
            <td>${b.metrics.avgResponseTime.toFixed(2)}</td>
            <td>${b.metrics.cpuUtilization.toFixed(1)}%</td>
            <td>${metCount} / ${b.scheduledJobs.length}</td>
          </tr>`;
      })
      .join("");

    renderComparisonCharts(benchmarks);
  }

  function renderComparisonCharts(benchmarks) {
    if (typeof Chart === "undefined") return;

    const labels = benchmarks.map((b) =>
      b.algoId === 4 ? `Round Robin (Q=${timeQuantum})` : ALGO_NAMES[b.algoId].split(" (")[0]
    );

    const wtData = benchmarks.map((b) => Number(b.metrics.avgWaitingTime.toFixed(2)));
    const tatData = benchmarks.map((b) => Number(b.metrics.avgTurnaroundTime.toFixed(2)));
    const rtData = benchmarks.map((b) => Number(b.metrics.avgResponseTime.toFixed(2)));
    const utilData = benchmarks.map((b) => Number(b.metrics.cpuUtilization.toFixed(2)));

    if (timeChartInstance) timeChartInstance.destroy();
    if (utilChartInstance) utilChartInstance.destroy();

    const ctx1 = document.getElementById("timeComparisonChart").getContext("2d");
    timeChartInstance = new Chart(ctx1, {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Avg Waiting Time", data: wtData, backgroundColor: "#3b82f6" },
          { label: "Avg Turnaround Time", data: tatData, backgroundColor: "#8b5cf6" },
          { label: "Avg Response Time", data: rtData, backgroundColor: "#06b6d4" }
        ]
      },
      options: {
        responsive: true,
        scales: { y: { beginAtZero: true } }
      }
    });

    const ctx2 = document.getElementById("utilComparisonChart").getContext("2d");
    utilChartInstance = new Chart(ctx2, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "CPU Utilization (%)",
            data: utilData,
            backgroundColor: ["#10b981", "#3b82f6", "#f59e0b", "#8b5cf6"]
          }
        ]
      },
      options: {
        responsive: true,
        scales: { y: { beginAtZero: true, max: 100 } }
      }
    });
  }

  /* ------------------------------------------------------------------------
     7. Job Management CRUD & Form Validation
  ------------------------------------------------------------------------ */
  function renderDashboardQuickTable(scheduledJobs) {
    const tbody = document.getElementById("dashboard-jobs-tbody");
    if (jobs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="muted-text">No jobs in queue. Click "+ Add Job" or "Load Sample Dataset".</td></tr>`;
      return;
    }

    tbody.innerHTML = jobs
      .map((j) => {
        const sched = scheduledJobs.find((s) => s.id === j.id);
        const statusHtml = sched
          ? `<span class="status-pill ok">Done @ t=${sched.completion}</span>`
          : `<span class="status-pill warn">Pending</span>`;
        return `
          <tr>
            <td><strong>#${j.id}</strong></td>
            <td>${escapeHtml(j.name)}</td>
            <td>${j.arrival}</td>
            <td>${j.burst}</td>
            <td>${j.priority}</td>
            <td>${j.deadline}</td>
            <td>${statusHtml}</td>
          </tr>`;
      })
      .join("");
  }

  function renderManageJobsTable() {
    const tbody = document.getElementById("manage-jobs-tbody");
    if (jobs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" class="muted-text">No jobs found. Add a job to get started.</td></tr>`;
      return;
    }

    tbody.innerHTML = jobs
      .map((j) => {
        const sched = lastScheduleResult.scheduledJobs.find((s) => s.id === j.id);
        let health = `<span class="status-pill warn">Unscheduled</span>`;
        if (sched) {
          health = sched.completion <= j.deadline
            ? `<span class="status-pill ok">On Time (${sched.completion}/${j.deadline})</span>`
            : `<span class="status-pill danger">Late (${sched.completion}/${j.deadline})</span>`;
        }

        return `
          <tr>
            <td><strong>#${j.id}</strong></td>
            <td>${escapeHtml(j.name)}</td>
            <td>${j.arrival}</td>
            <td>${j.burst}</td>
            <td>${j.priority}</td>
            <td>${j.deadline}</td>
            <td>${health}</td>
            <td>
              <button class="btn btn-sm btn-outline" onclick="window.editJobById(${j.id})">✏️ Edit</button>
              <button class="btn btn-sm btn-danger" onclick="window.deleteJobById(${j.id})">🗑️ Delete</button>
            </td>
          </tr>`;
      })
      .join("");
  }

  function clearFormErrors() {
    ["err-job-id", "err-job-name", "err-job-arrival", "err-job-burst", "err-job-priority", "err-job-deadline"]
      .forEach((id) => (document.getElementById(id).textContent = ""));
  }

  function resetJobForm() {
    document.getElementById("job-form").reset();
    document.getElementById("edit-mode-original-id").value = "";
    document.getElementById("job-form-title").textContent = "➕ Add New Job to Scheduler Queue";
    document.getElementById("btn-submit-job").textContent = "Save Job & Schedule";
    document.getElementById("btn-cancel-edit").style.display = "none";
    clearFormErrors();
  }

  window.editJobById = function (id) {
    const job = jobs.find((j) => j.id === id);
    if (!job) return;

    clearFormErrors();
    document.getElementById("edit-mode-original-id").value = String(job.id);
    document.getElementById("job-id").value = job.id;
    document.getElementById("job-name").value = job.name;
    document.getElementById("job-arrival").value = job.arrival;
    document.getElementById("job-burst").value = job.burst;
    document.getElementById("job-priority").value = job.priority;
    document.getElementById("job-deadline").value = job.deadline;

    document.getElementById("job-form-title").textContent = `✏️ Edit Job #${job.id} (${job.name})`;
    document.getElementById("btn-submit-job").textContent = "Update Job & Re-Schedule";
    document.getElementById("btn-cancel-edit").style.display = "inline-flex";

    switchSection("add-jobs");
  };

  window.deleteJobById = function (id) {
    jobs = jobs.filter((j) => j.id !== id);
    showToast(`Deleted Job #${id}.`, "success");
    executeCurrentSchedule();
  };

  function handleJobFormSubmit(e) {
    e.preventDefault();
    clearFormErrors();

    const originalIdRaw = document.getElementById("edit-mode-original-id").value;
    const isEditing = originalIdRaw !== "";
    const originalId = isEditing ? Number(originalIdRaw) : null;

    const id = Number(document.getElementById("job-id").value);
    const name = document.getElementById("job-name").value.trim();
    const arrival = Number(document.getElementById("job-arrival").value);
    const burst = Number(document.getElementById("job-burst").value);
    const priority = Number(document.getElementById("job-priority").value);
    const deadline = Number(document.getElementById("job-deadline").value);

    let valid = true;

    if (!Number.isInteger(id) || id <= 0) {
      document.getElementById("err-job-id").textContent = "Job ID must be a positive integer.";
      valid = false;
    } else if ((!isEditing || id !== originalId) && jobs.some((j) => j.id === id)) {
      document.getElementById("err-job-id").textContent = `Job ID #${id} already exists. Must be unique.`;
      valid = false;
    }

    if (!name) {
      document.getElementById("err-job-name").textContent = "Job Name is required.";
      valid = false;
    }

    if (!Number.isInteger(arrival) || arrival < 0) {
      document.getElementById("err-job-arrival").textContent = "Arrival Time must be ≥ 0.";
      valid = false;
    }

    if (!Number.isInteger(burst) || burst <= 0) {
      document.getElementById("err-job-burst").textContent = "Burst Time must be > 0.";
      valid = false;
    }

    if (!Number.isInteger(priority) || priority < 1) {
      document.getElementById("err-job-priority").textContent = "Priority must be ≥ 1 (1 = Highest).";
      valid = false;
    }

    if (!Number.isInteger(deadline) || deadline < arrival + burst) {
      document.getElementById("err-job-deadline").textContent = `Deadline should be at least ${arrival + burst} (Arrival + Burst).`;
      valid = false;
    }

    if (!valid) return;

    if (isEditing) {
      const idx = jobs.findIndex((j) => j.id === originalId);
      if (idx !== -1) {
        jobs[idx] = { id, name, arrival, burst, priority, deadline };
      }
      showToast(`Updated Job #${id} (${name}) and re-ran C scheduler.`, "success");
    } else {
      if (jobs.length >= 100) {
        showToast("Maximum capacity of 100 jobs reached.", "error");
        return;
      }
      jobs.push({ id, name, arrival, burst, priority, deadline });
      showToast(`Added Job #${id} (${name}) and scheduled via C engine.`, "success");
    }

    resetJobForm();
    executeCurrentSchedule();
    switchSection("dashboard");
  }

  /* ------------------------------------------------------------------------
     8. Navigation, Theme Switcher & Controls
  ------------------------------------------------------------------------ */
  function switchSection(sectionKey) {
    document.querySelectorAll(".page-section").forEach((sec) => sec.classList.remove("active"));
    document.querySelectorAll(".nav-item").forEach((btn) => btn.classList.remove("active"));

    const targetSec = document.getElementById(`section-${sectionKey}`);
    const targetNav = document.querySelector(`.nav-item[data-section="${sectionKey}"]`);

    if (targetSec) targetSec.classList.add("active");
    if (targetNav) {
      targetNav.classList.add("active");
      document.getElementById("page-title").textContent = targetNav.querySelector("span:nth-child(2)").textContent;
    }

    document.getElementById("sidebar").classList.remove("open");
  }

  function syncAlgorithmSelection(newAlgoId) {
    activeAlgo = Number(newAlgoId);
    document.getElementById("global-algo-select").value = String(activeAlgo);

    const showQuantum = activeAlgo === 4;
    document.getElementById("topbar-quantum-wrap").style.display = showQuantum ? "flex" : "none";

    document.querySelectorAll(".algo-card").forEach((card) => {
      const cardAlgo = Number(card.dataset.algo);
      card.classList.toggle("selected", cardAlgo === activeAlgo);
      const btn = card.querySelector(".select-algo-btn");
      btn.className = cardAlgo === activeAlgo ? "btn btn-sm btn-primary select-algo-btn" : "btn btn-sm btn-outline select-algo-btn";
    });

    executeCurrentSchedule();
  }

  function syncQuantumValue(val) {
    const parsed = Math.max(1, Math.min(50, Number(val) || 2));
    timeQuantum = parsed;
    document.getElementById("global-quantum-input").value = parsed;
    document.getElementById("algo-quantum-input").value = parsed;
    if (activeAlgo === 4) {
      executeCurrentSchedule();
    }
  }

  function showToast(message, type = "info") {
    const container = document.getElementById("toast-container");
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3400);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* ------------------------------------------------------------------------
     9. Event Listeners Bootstrapping
  ------------------------------------------------------------------------ */
  document.addEventListener("DOMContentLoaded", () => {
    // Sidebar navigation
    document.querySelectorAll(".nav-item").forEach((btn) => {
      btn.addEventListener("click", () => switchSection(btn.dataset.section));
    });

    // Jump buttons inside cards
    document.querySelectorAll("[data-jump]").forEach((btn) => {
      btn.addEventListener("click", () => switchSection(btn.dataset.jump));
    });

    // Mobile sidebar toggle
    document.getElementById("mobile-menu-btn").addEventListener("click", () => {
      document.getElementById("sidebar").classList.toggle("open");
    });

    // Dark / Light Theme toggle
    const themeBtn = document.getElementById("theme-toggle");
    themeBtn.addEventListener("click", () => {
      const root = document.documentElement;
      const isDark = root.getAttribute("data-theme") === "dark";
      root.setAttribute("data-theme", isDark ? "light" : "dark");
      themeBtn.textContent = isDark ? "🌙" : "☀️";
    });

    // Algorithm selectors
    document.getElementById("global-algo-select").addEventListener("change", (e) => {
      syncAlgorithmSelection(e.target.value);
    });

    document.querySelectorAll(".select-algo-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (Number(btn.dataset.algo) === 4) {
          syncQuantumValue(document.getElementById("algo-quantum-input").value);
        }
        syncAlgorithmSelection(btn.dataset.algo);
        showToast(`Switched to ${ALGO_NAMES[activeAlgo]}`, "success");
      });
    });

    // Quantum inputs
    document.getElementById("global-quantum-input").addEventListener("change", (e) => syncQuantumValue(e.target.value));
    document.getElementById("algo-quantum-input").addEventListener("change", (e) => syncQuantumValue(e.target.value));

    // Manual Run C Scheduler button
    document.getElementById("btn-run-now").addEventListener("click", () => {
      executeCurrentSchedule();
      showToast(`Executed ${ALGO_NAMES[activeAlgo]} in C WebAssembly engine.`, "success");
    });

    // Form submit & reset
    document.getElementById("job-form").addEventListener("submit", handleJobFormSubmit);
    document.getElementById("btn-reset-form").addEventListener("click", resetJobForm);
    document.getElementById("btn-cancel-edit").addEventListener("click", () => {
      resetJobForm();
      switchSection("manage-jobs");
    });

    // Sample data & clear buttons
    const loadSamples = () => {
      jobs = JSON.parse(JSON.stringify(DEFAULT_JOBS));
      executeCurrentSchedule();
      showToast("Sample dataset loaded and scheduled via C engine.", "success");
    };
    document.getElementById("btn-load-sample").addEventListener("click", loadSamples);
    document.getElementById("btn-load-sample-2").addEventListener("click", loadSamples);

    document.getElementById("btn-clear-all-jobs").addEventListener("click", () => {
      jobs = [];
      executeCurrentSchedule();
      showToast("All jobs cleared.", "info");
    });

    document.getElementById("btn-refresh-comparison").addEventListener("click", () => {
      runAllAlgorithmsBenchmark();
      showToast("Re-benchmarked all 4 algorithms in C.", "success");
    });

    // Initialize WebAssembly bridge
    initWasmBridge();
  });
})();