/**
 * Smart Job Scheduling System - C Scheduling Engine
 * Implements:
 * 1. First Come First Serve (FCFS) - Non-preemptive
 * 2. Shortest Job First (SJF) - Non-preemptive
 * 3. Priority Scheduling - Non-preemptive (Lower priority number = Higher priority)
 * 4. Round Robin (RR) - Preemptive with configurable time quantum
 */

#include <stdio.h>
#include <stdlib.h>
#include <stdbool.h>
#include <limits.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

#define MAX_JOBS 100
#define MAX_GANTT 1000
#define RR_QUEUE_CAP (MAX_JOBS * 200)

/* Input Job Structure (9 ints = 36 bytes per job) */
typedef struct {
    int id;
    int arrival_time;
    int burst_time;
    int priority;       /* Lower number = Higher priority (e.g., 1 is highest) */
    int deadline;
    int completion_time;
    int turnaround_time;
    int waiting_time;
    int response_time;
} Job;

/* Gantt Chart Block Structure (4 ints = 16 bytes per block) */
typedef struct {
    int job_id;         /* -1 represents CPU IDLE time */
    int start_time;
    int end_time;
    int duration;
} GanttBlock;

/* Summary Metrics Structure (4 floats = 16 bytes) */
typedef struct {
    float avg_waiting_time;
    float avg_turnaround_time;
    float avg_response_time;
    float cpu_utilization;
} SummaryMetrics;

/* Helper: Append or merge a block into the Gantt chart timeline */
void add_gantt_block(GanttBlock *gantt, int *gantt_count, int job_id, int start, int end) {
    if (start >= end) return;

    /* Merge contiguous blocks for the same job (or contiguous IDLE blocks) */
    if (*gantt_count > 0 && gantt[*gantt_count - 1].job_id == job_id && gantt[*gantt_count - 1].end_time == start) {
        gantt[*gantt_count - 1].end_time = end;
        gantt[*gantt_count - 1].duration = end - gantt[*gantt_count - 1].start_time;
        return;
    }

    if (*gantt_count < MAX_GANTT) {
        gantt[*gantt_count].job_id = job_id;
        gantt[*gantt_count].start_time = start;
        gantt[*gantt_count].end_time = end;
        gantt[*gantt_count].duration = end - start;
        (*gantt_count)++;
    }
}

/* Algorithm 1: First Come First Serve (FCFS) */
void schedule_fcfs(Job *jobs, int n, GanttBlock *gantt, int *gantt_count) {
    int completed = 0;
    int current_time = 0;
    bool is_done[MAX_JOBS] = {false};

    while (completed < n) {
        int idx = -1;
        int earliest_arrival = INT_MAX;

        /* Find earliest arrived uncompleted job (tie-break by Job ID) */
        for (int i = 0; i < n; i++) {
            if (!is_done[i]) {
                if (jobs[i].arrival_time < earliest_arrival ||
                   (jobs[i].arrival_time == earliest_arrival && idx != -1 && jobs[i].id < jobs[idx].id)) {
                    earliest_arrival = jobs[i].arrival_time;
                    idx = i;
                }
            }
        }

        /* Handle CPU Idle period if next job hasn't arrived yet */
        if (jobs[idx].arrival_time > current_time) {
            add_gantt_block(gantt, gantt_count, -1, current_time, jobs[idx].arrival_time);
            current_time = jobs[idx].arrival_time;
        }

        int start_time = current_time;
        int end_time = start_time + jobs[idx].burst_time;

        add_gantt_block(gantt, gantt_count, jobs[idx].id, start_time, end_time);

        jobs[idx].completion_time = end_time;
        jobs[idx].turnaround_time = jobs[idx].completion_time - jobs[idx].arrival_time;
        jobs[idx].waiting_time = jobs[idx].turnaround_time - jobs[idx].burst_time;
        jobs[idx].response_time = start_time - jobs[idx].arrival_time;

        is_done[idx] = true;
        completed++;
        current_time = end_time;
    }
}

/* Algorithm 2: Shortest Job First (SJF - Non-Preemptive) */
void schedule_sjf(Job *jobs, int n, GanttBlock *gantt, int *gantt_count) {
    int completed = 0;
    int current_time = 0;
    bool is_done[MAX_JOBS] = {false};

    while (completed < n) {
        int idx = -1;
        int min_burst = INT_MAX;

        /* Find available job with shortest burst time */
        for (int i = 0; i < n; i++) {
            if (!is_done[i] && jobs[i].arrival_time <= current_time) {
                if (jobs[i].burst_time < min_burst ||
                   (jobs[i].burst_time == min_burst && idx != -1 && jobs[i].arrival_time < jobs[idx].arrival_time) ||
                   (jobs[i].burst_time == min_burst && idx != -1 && jobs[i].arrival_time == jobs[idx].arrival_time && jobs[i].id < jobs[idx].id)) {
                    min_burst = jobs[i].burst_time;
                    idx = i;
                }
            }
        }

        /* If no job has arrived yet, advance time to earliest next arrival (CPU Idle) */
        if (idx == -1) {
            int next_arrival = INT_MAX;
            for (int i = 0; i < n; i++) {
                if (!is_done[i] && jobs[i].arrival_time < next_arrival) {
                    next_arrival = jobs[i].arrival_time;
                }
            }
            add_gantt_block(gantt, gantt_count, -1, current_time, next_arrival);
            current_time = next_arrival;
            continue;
        }

        int start_time = current_time;
        int end_time = start_time + jobs[idx].burst_time;

        add_gantt_block(gantt, gantt_count, jobs[idx].id, start_time, end_time);

        jobs[idx].completion_time = end_time;
        jobs[idx].turnaround_time = jobs[idx].completion_time - jobs[idx].arrival_time;
        jobs[idx].waiting_time = jobs[idx].turnaround_time - jobs[idx].burst_time;
        jobs[idx].response_time = start_time - jobs[idx].arrival_time;

        is_done[idx] = true;
        completed++;
        current_time = end_time;
    }
}

/* Algorithm 3: Priority Scheduling (Non-Preemptive; Lower value = Higher priority) */
void schedule_priority(Job *jobs, int n, GanttBlock *gantt, int *gantt_count) {
    int completed = 0;
    int current_time = 0;
    bool is_done[MAX_JOBS] = {false};

    while (completed < n) {
        int idx = -1;
        int highest_priority = INT_MAX; /* Lower integer means higher priority */

        for (int i = 0; i < n; i++) {
            if (!is_done[i] && jobs[i].arrival_time <= current_time) {
                if (jobs[i].priority < highest_priority ||
                   (jobs[i].priority == highest_priority && idx != -1 && jobs[i].arrival_time < jobs[idx].arrival_time) ||
                   (jobs[i].priority == highest_priority && idx != -1 && jobs[i].arrival_time == jobs[idx].arrival_time && jobs[i].id < jobs[idx].id)) {
                    highest_priority = jobs[i].priority;
                    idx = i;
                }
            }
        }

        /* Handle CPU Idle time */
        if (idx == -1) {
            int next_arrival = INT_MAX;
            for (int i = 0; i < n; i++) {
                if (!is_done[i] && jobs[i].arrival_time < next_arrival) {
                    next_arrival = jobs[i].arrival_time;
                }
            }
            add_gantt_block(gantt, gantt_count, -1, current_time, next_arrival);
            current_time = next_arrival;
            continue;
        }

        int start_time = current_time;
        int end_time = start_time + jobs[idx].burst_time;

        add_gantt_block(gantt, gantt_count, jobs[idx].id, start_time, end_time);

        jobs[idx].completion_time = end_time;
        jobs[idx].turnaround_time = jobs[idx].completion_time - jobs[idx].arrival_time;
        jobs[idx].waiting_time = jobs[idx].turnaround_time - jobs[idx].burst_time;
        jobs[idx].response_time = start_time - jobs[idx].arrival_time;

        is_done[idx] = true;
        completed++;
        current_time = end_time;
    }
}

/* Algorithm 4: Round Robin Scheduling (Preemptive with Time Quantum) */
void schedule_round_robin(Job *jobs, int n, int quantum, GanttBlock *gantt, int *gantt_count) {
    if (quantum <= 0) quantum = 1;

    int remaining_burst[MAX_JOBS];
    int first_start[MAX_JOBS];
    bool in_queue[MAX_JOBS];
    int queue[RR_QUEUE_CAP];
    int front = 0, rear = 0, qcount = 0;

    for (int i = 0; i < n; i++) {
        remaining_burst[i] = jobs[i].burst_time;
        first_start[i] = -1;
        in_queue[i] = false;
    }

    /* Sort index order by arrival time to enqueue arrivals consistently */
    int order[MAX_JOBS];
    for (int i = 0; i < n; i++) {
        order[i] = i;
    }
    for (int i = 0; i < n - 1; i++) {
        for (int j = 0; j < n - i - 1; j++) {
            if (jobs[order[j]].arrival_time > jobs[order[j + 1]].arrival_time ||
               (jobs[order[j]].arrival_time == jobs[order[j + 1]].arrival_time && jobs[order[j]].id > jobs[order[j + 1]].id)) {
                int tmp = order[j];
                order[j] = order[j + 1];
                order[j + 1] = tmp;
            }
        }
    }

    int completed = 0;
    int current_time = 0;

    /* If first job arrives after time 0, record initial CPU idle period */
    if (n > 0 && jobs[order[0]].arrival_time > 0) {
        add_gantt_block(gantt, gantt_count, -1, 0, jobs[order[0]].arrival_time);
        current_time = jobs[order[0]].arrival_time;
    }

    /* Enqueue all jobs that have arrived by current_time */
    for (int i = 0; i < n; i++) {
        int idx = order[i];
        if (jobs[idx].arrival_time <= current_time && !in_queue[idx] && qcount < RR_QUEUE_CAP) {
            queue[rear] = idx;
            rear = (rear + 1) % RR_QUEUE_CAP;
            qcount++;
            in_queue[idx] = true;
        }
    }

    while (completed < n) {
        /* If ready queue is empty, jump to next arriving job */
        if (qcount == 0) {
            int next_arrival = INT_MAX;
            for (int i = 0; i < n; i++) {
                if (remaining_burst[i] > 0 && jobs[i].arrival_time < next_arrival) {
                    next_arrival = jobs[i].arrival_time;
                }
            }
            if (next_arrival == INT_MAX) {
                break;
            }
            if (next_arrival > current_time) {
                add_gantt_block(gantt, gantt_count, -1, current_time, next_arrival);
                current_time = next_arrival;
            }

            for (int i = 0; i < n; i++) {
                int cand = order[i];
                if (remaining_burst[cand] > 0 && jobs[cand].arrival_time <= current_time && !in_queue[cand] && qcount < RR_QUEUE_CAP) {
                    queue[rear] = cand;
                    rear = (rear + 1) % RR_QUEUE_CAP;
                    qcount++;
                    in_queue[cand] = true;
                }
            }
            if (qcount == 0) {
                current_time++;
            }
            continue;
        }

        int idx = queue[front];
        front = (front + 1) % RR_QUEUE_CAP;
        qcount--;
        in_queue[idx] = false;

        if (first_start[idx] == -1) {
            first_start[idx] = current_time;
        }

        int exec_time = (remaining_burst[idx] < quantum) ? remaining_burst[idx] : quantum;
        int start_time = current_time;
        int end_time = start_time + exec_time;

        add_gantt_block(gantt, gantt_count, jobs[idx].id, start_time, end_time);

        remaining_burst[idx] -= exec_time;
        current_time = end_time;

        /* Enqueue any new jobs that arrived while current job was executing */
        for (int i = 0; i < n; i++) {
            int cand = order[i];
            if (cand != idx && remaining_burst[cand] > 0 && jobs[cand].arrival_time <= current_time && !in_queue[cand] && qcount < RR_QUEUE_CAP) {
                queue[rear] = cand;
                rear = (rear + 1) % RR_QUEUE_CAP;
                qcount++;
                in_queue[cand] = true;
            }
        }

        /* Re-enqueue current job if it still needs CPU time, else finalize metrics */
        if (remaining_burst[idx] > 0) {
            if (qcount < RR_QUEUE_CAP) {
                queue[rear] = idx;
                rear = (rear + 1) % RR_QUEUE_CAP;
                qcount++;
                in_queue[idx] = true;
            }
        } else {
            completed++;
            jobs[idx].completion_time = current_time;
            jobs[idx].turnaround_time = jobs[idx].completion_time - jobs[idx].arrival_time;
            jobs[idx].waiting_time = jobs[idx].turnaround_time - jobs[idx].burst_time;
            jobs[idx].response_time = first_start[idx] - jobs[idx].arrival_time;
        }
    }
}

/**
 * Main Entry Point called from JavaScript via WebAssembly
 *
 * Parameters:
 *   algo_id      : 1 = FCFS, 2 = SJF, 3 = Priority, 4 = Round Robin
 *   n            : Number of jobs (1..MAX_JOBS)
 *   quantum      : Time quantum (used for Round Robin)
 *   jobs_ptr     : Pointer to array of Job structs (read & updated in-place)
 *   gantt_ptr    : Pointer to output array of GanttBlock structs
 *   metrics_ptr  : Pointer to output SummaryMetrics struct
 *
 * Returns:
 *   Number of Gantt blocks generated (or -1 on invalid input)
 */
EMSCRIPTEN_KEEPALIVE
int run_scheduler(int algo_id, int n, int quantum, Job *jobs_ptr, GanttBlock *gantt_ptr, SummaryMetrics *metrics_ptr) {
    if (n <= 0 || n > MAX_JOBS || jobs_ptr == NULL || gantt_ptr == NULL || metrics_ptr == NULL) {
        return -1;
    }

    int gantt_count = 0;

    switch (algo_id) {
        case 1:
            schedule_fcfs(jobs_ptr, n, gantt_ptr, &gantt_count);
            break;
        case 2:
            schedule_sjf(jobs_ptr, n, gantt_ptr, &gantt_count);
            break;
        case 3:
            schedule_priority(jobs_ptr, n, gantt_ptr, &gantt_count);
            break;
        case 4:
            schedule_round_robin(jobs_ptr, n, quantum, gantt_ptr, &gantt_count);
            break;
        default:
            return -1;
    }

    /* Calculate Aggregate Performance Metrics */
    float total_wt = 0.0f;
    float total_tat = 0.0f;
    float total_rt = 0.0f;
    int total_burst = 0;
    int min_arrival = INT_MAX;
    int max_completion = 0;

    for (int i = 0; i < n; i++) {
        total_wt += jobs_ptr[i].waiting_time;
        total_tat += jobs_ptr[i].turnaround_time;
        total_rt += jobs_ptr[i].response_time;
        total_burst += jobs_ptr[i].burst_time;

        if (jobs_ptr[i].arrival_time < min_arrival) {
            min_arrival = jobs_ptr[i].arrival_time;
        }
        if (jobs_ptr[i].completion_time > max_completion) {
            max_completion = jobs_ptr[i].completion_time;
        }
    }

    /* Total elapsed timeline from time 0 (or first start) to final completion */
    int total_elapsed = max_completion;
    if (total_elapsed <= 0) total_elapsed = 1;

    metrics_ptr->avg_waiting_time = total_wt / (float)n;
    metrics_ptr->avg_turnaround_time = total_tat / (float)n;
    metrics_ptr->avg_response_time = total_rt / (float)n;
    metrics_ptr->cpu_utilization = ((float)total_burst / (float)total_elapsed) * 100.0f;

    return gantt_count;
}