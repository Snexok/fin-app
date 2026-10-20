# breakpoint-pool20

Длительность: 266 с

| Эндпоинт | запросов | RPS (TPS) | TPM | p50, мс | p95, мс | p99, мс | max, мс | ошибки |
|---|---|---|---|---|---|---|---|---|
| GET / | 8800 | 33.1 | 1985 | 5 | 11 | 15 | 47 | 0.00%  |
| GET /api/health | 8768 | 33.0 | 1978 | 265 | 837 | 988 | 1058 | 0.00%  |
| POST /api/chat | 19914 | 74.9 | 4492 | 353 | 10230 | 10512 | 11324 | 0.00%  |
| POST /api/v1/analytics | 12210 | 45.9 | 2754 | 2677 | 9542 | 9741 | 10706 | 0.00%  |
| POST /api/v1/finance/simulations | 12200 | 45.9 | 2752 | 2706 | 9569 | 9774 | 10530 | 0.00%  |
| POST /api/v1/onboarding | 5124 | 19.3 | 1156 | 2070 | 8785 | 9002 | 9646 | 0.00%  |
| POST /api/v1/onboarding/turn | 5124 | 19.3 | 1156 | 1571 | 12619 | 12789 | 14094 | 0.00%  |
| POST /api/v1/session | 5124 | 19.3 | 1156 | 384 | 1662 | 1844 | 2721 | 0.00%  |
| **Итого** | 77264 | 290.5 | 17428 | 191 | 9717 | 12031 | 14094 | 0.00%  |

dropped_iterations: 9227

| Окно (с от старта) | запросов | RPS (TPS) | TPM | p50, мс | p95, мс | p99, мс | max, мс | ошибки |
|---|---|---|---|---|---|---|---|---| dropped |
| 20-65 | 8956 | 199.0 | 11941 | 10 | 23 | 125 | 430 | 0.00%  | 0 |
| 85-130 | 13419 | 298.2 | 17892 | 15 | 164 | 297 | 703 | 0.00%  | 27 |
| 150-195 | 14153 | 314.5 | 18871 | 2866 | 6699 | 8018 | 8703 | 0.00%  | 1867 |
| 215-260 | 16007 | 355.7 | 21343 | 8676 | 11650 | 12690 | 14094 | 0.00%  | 5396 |

## k6 summary

```
time="2026-10-17T22:09:58+03:00" level=warning msg="Insufficient VUs, reached 600 active VUs and cannot initialize more" executor=ramping-arrival-rate scenario=chat
time="2026-10-17T22:10:47+03:00" level=warning msg="Insufficient VUs, reached 600 active VUs and cannot initialize more" executor=ramping-arrival-rate scenario=sim
time="2026-10-17T22:10:47+03:00" level=warning msg="Insufficient VUs, reached 600 active VUs and cannot initialize more" executor=ramping-arrival-rate scenario=analytics
time="2026-10-17T22:11:00+03:00" level=warning msg="Insufficient VUs, reached 600 active VUs and cannot initialize more" executor=ramping-arrival-rate scenario=onboarding
  █ THRESHOLDS 
    http_req_duration{flow:analytics}
    ✗ 'p(95)<300' p(95)=9.54s
    http_req_duration{flow:chat}
    ✗ 'p(95)<500' p(95)=10.22s
    http_req_duration{flow:health}
    ✗ 'p(95)<200' p(95)=837.44ms
    http_req_duration{flow:onboarding}
    ✗ 'p(95)<500' p(95)=12.03s
    http_req_duration{flow:page}
    ✓ 'p(95)<200' p(95)=10.82ms
    http_req_duration{flow:sim}
    ✗ 'p(95)<500' p(95)=9.56s
    http_req_failed
    ✓ 'rate<0.01' rate=0.00%
  █ TOTAL RESULTS 
    checks_total.......: 72140   256.518567/s
    checks_succeeded...: 100.00% 72140 out of 72140
    checks_failed......: 0.00%   0 out of 72140
    ✓ chat 200 + verdict
    ✓ analytics 202
    ✓ health 200
    ✓ sim 200
    ✓ page 200
    ✓ onboarding open 200
    ✓ onboarding turn 200
    HTTP
    http_req_duration..............: avg=2.46s    min=810.27µs med=55.48ms  p(90)=9.02s    p(95)=9.66s    p(99)=11.96s   max=14.09s 
      { expected_response:true }...: avg=2.46s    min=810.27µs med=55.48ms  p(90)=9.02s    p(95)=9.66s    p(99)=11.96s   max=14.09s 
      { flow:analytics }...........: avg=3.88s    min=5.22ms   med=2.67s    p(90)=9.28s    p(95)=9.54s    p(99)=9.74s    max=10.7s  
      { flow:chat }................: avg=3.13s    min=6.1ms    med=352.65ms p(90)=9.8s     p(95)=10.22s   p(99)=10.51s   max=11.32s 
      { flow:health }..............: avg=351.73ms min=2.17ms   med=265.23ms p(90)=793.32ms p(95)=837.44ms p(99)=988.03ms max=1.05s  
      { flow:onboarding }..........: avg=2.9s     min=2.15ms   med=712.65ms p(90)=9.39s    p(95)=12.03s   p(99)=12.7s    max=14.09s 
      { flow:page }................: avg=5.37ms   min=810.27µs med=4.99ms   p(90)=9.16ms   p(95)=10.82ms  p(99)=15.16ms  max=46.78ms
      { flow:sim }.................: avg=3.9s     min=7.18ms   med=2.7s     p(90)=9.31s    p(95)=9.56s    p(99)=9.77s    max=10.53s 
    http_req_failed................: 0.00%  0 out of 83264
    http_reqs......................: 83264  296.073773/s
    EXECUTION
    dropped_iterations.............: 9227   32.80977/s
    iteration_duration.............: avg=3.06s    min=884.86µs med=163.78ms p(90)=9.38s    p(95)=10.14s   p(99)=22.08s   max=24.21s 
    iterations.....................: 67016  238.298424/s
    vus............................: 237    min=0          max=2445
    vus_max........................: 2471   min=120        max=2471
    NETWORK
    data_received..................: 391 MB 1.4 MB/s
    data_sent......................: 24 MB  84 kB/s
time="2026-10-17T22:11:25+03:00" level=error msg="thresholds on metrics 'http_req_duration{flow:analytics}, http_req_duration{flow:chat}, http_req_duration{flow:health}, http_req_duration{flow:onboarding}, http_req_duration{flow:sim}' have been crossed"
```
