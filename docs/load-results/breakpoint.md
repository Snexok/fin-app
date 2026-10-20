# breakpoint

Длительность: 330 с

| Эндпоинт | запросов | RPS (TPS) | TPM | p50, мс | p95, мс | p99, мс | max, мс | ошибки |
|---|---|---|---|---|---|---|---|---|
| GET / | 12600 | 38.2 | 2291 | 3 | 6 | 9 | 46 | 0.00%  |
| GET /api/health | 12556 | 38.0 | 2283 | 771 | 966 | 1063 | 1131 | 0.00%  |
| POST /api/chat | 22326 | 67.7 | 4059 | 1978 | 11504 | 11873 | 12779 | 0.00%  |
| POST /api/v1/analytics | 15536 | 47.1 | 2825 | 7509 | 10745 | 11058 | 12303 | 0.00%  |
| POST /api/v1/finance/simulations | 15530 | 47.1 | 2824 | 7514 | 10732 | 11056 | 12354 | 0.00%  |
| POST /api/v1/onboarding | 6485 | 19.7 | 1179 | 6879 | 9812 | 10155 | 11074 | 0.00%  |
| POST /api/v1/onboarding/turn | 6485 | 19.7 | 1179 | 9470 | 14244 | 14541 | 15445 | 0.00%  |
| POST /api/v1/session | 6485 | 19.7 | 1179 | 1243 | 1893 | 2095 | 2987 | 0.00%  |
| **Итого** | 98003 | 297.0 | 17819 | 828 | 11398 | 13991 | 15445 | 0.00%  |

dropped_iterations: 24141

| Окно (с от старта) | запросов | RPS (TPS) | TPM | p50, мс | p95, мс | p99, мс | max, мс | ошибки |
|---|---|---|---|---|---|---|---|---| dropped |
| 20-65 | 8959 | 199.1 | 11945 | 10 | 25 | 197 | 381 | 0.00%  | 0 |
| 85-130 | 13458 | 299.1 | 17944 | 24 | 388 | 512 | 723 | 0.00%  | 36 |
| 150-195 | 13358 | 296.8 | 17811 | 4312 | 8033 | 9614 | 10404 | 0.00%  | 2497 |
| 215-260 | 15190 | 337.6 | 20253 | 10170 | 13521 | 14118 | 15047 | 0.00%  | 6342 |
| 280-325 | 16227 | 360.6 | 21636 | 10129 | 13719 | 14037 | 15398 | 0.00%  | 9330 |

## k6 summary

```
time="2026-10-17T22:02:29+03:00" level=warning msg="Insufficient VUs, reached 600 active VUs and cannot initialize more" executor=ramping-arrival-rate scenario=chat
time="2026-10-17T22:03:14+03:00" level=warning msg="Insufficient VUs, reached 600 active VUs and cannot initialize more" executor=ramping-arrival-rate scenario=sim
time="2026-10-17T22:03:15+03:00" level=warning msg="Insufficient VUs, reached 600 active VUs and cannot initialize more" executor=ramping-arrival-rate scenario=analytics
time="2026-10-17T22:03:27+03:00" level=warning msg="Insufficient VUs, reached 600 active VUs and cannot initialize more" executor=ramping-arrival-rate scenario=onboarding
  █ THRESHOLDS 
    http_req_duration{flow:analytics}
    ✗ 'p(95)<300' p(95)=10.74s
    http_req_duration{flow:chat}
    ✗ 'p(95)<500' p(95)=11.5s
    http_req_duration{flow:health}
    ✗ 'p(95)<200' p(95)=965.76ms
    http_req_duration{flow:onboarding}
    ✗ 'p(95)<500' p(95)=13.99s
    http_req_duration{flow:page}
    ✓ 'p(95)<200' p(95)=6.35ms
    http_req_duration{flow:sim}
    ✗ 'p(95)<500' p(95)=10.73s
    http_req_failed
    ✓ 'rate<0.01' rate=0.00%
  █ TOTAL RESULTS 
    checks_total.......: 91518   264.411091/s
    checks_succeeded...: 100.00% 91518 out of 91518
    checks_failed......: 0.00%   0 out of 91518
    ✓ chat 200 + verdict
    ✓ analytics 202
    ✓ sim 200
    ✓ health 200
    ✓ page 200
    ✓ onboarding open 200
    ✓ onboarding turn 200
    HTTP
    http_req_duration..............: avg=3.67s    min=787.26µs med=606.55ms p(90)=10.72s   p(95)=11.37s   p(99)=13.98s max=15.44s 
      { expected_response:true }...: avg=3.67s    min=787.26µs med=606.55ms p(90)=10.72s   p(95)=11.37s   p(99)=13.98s max=15.44s 
      { flow:analytics }...........: avg=5.87s    min=5.33ms   med=7.5s     p(90)=10.57s   p(95)=10.74s   p(99)=11.05s max=12.3s  
      { flow:chat }................: avg=4.68s    min=6.01ms   med=1.97s    p(90)=11.38s   p(95)=11.5s    p(99)=11.87s max=12.77s 
      { flow:health }..............: avg=551.52ms min=1.26ms   med=770.91ms p(90)=929.69ms p(95)=965.76ms p(99)=1.06s  max=1.13s  
      { flow:onboarding }..........: avg=4.53s    min=2.23ms   med=1.71s    p(90)=13.76s   p(95)=13.99s   p(99)=14.42s max=15.44s 
      { flow:page }................: avg=3.13ms   min=787.26µs med=2.71ms   p(90)=5.16ms   p(95)=6.35ms   p(99)=9.35ms max=45.55ms
      { flow:sim }.................: avg=5.88s    min=7.49ms   med=7.51s    p(90)=10.57s   p(95)=10.73s   p(99)=11.05s max=12.35s 
    http_req_failed................: 0.00%  0 out of 104003
    http_reqs......................: 104003 300.482383/s
    EXECUTION
    dropped_iterations.............: 24141  69.747461/s
    iteration_duration.............: avg=4.49s    min=892.31µs med=791.92ms p(90)=11.13s   p(95)=11.69s   p(99)=25.43s max=27.51s 
    iterations.....................: 85033  245.674821/s
    vus............................: 168    min=0           max=2459
    vus_max........................: 2484   min=120         max=2484
    NETWORK
    data_received..................: 471 MB 1.4 MB/s
    data_sent......................: 29 MB  83 kB/s
time="2026-10-17T22:05:10+03:00" level=error msg="thresholds on metrics 'http_req_duration{flow:analytics}, http_req_duration{flow:chat}, http_req_duration{flow:health}, http_req_duration{flow:onboarding}, http_req_duration{flow:sim}' have been crossed"
```
