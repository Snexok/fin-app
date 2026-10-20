# stress

Длительность: 480 с

| Эндпоинт | запросов | RPS (TPS) | TPM | p50, мс | p95, мс | p99, мс | max, мс | ошибки |
|---|---|---|---|---|---|---|---|---|
| GET / | 3219 | 6.7 | 402 | 2 | 6 | 9 | 15 | 0.00%  |
| GET /api/health | 3219 | 6.7 | 402 | 4 | 8 | 11 | 154 | 0.00%  |
| POST /api/chat | 9499 | 19.8 | 1187 | 12 | 22 | 46 | 382 | 0.00%  |
| POST /api/v1/analytics | 4829 | 10.1 | 604 | 9 | 18 | 34 | 326 | 0.00%  |
| POST /api/v1/finance/simulations | 4829 | 10.1 | 604 | 12 | 21 | 39 | 328 | 0.00%  |
| POST /api/v1/onboarding | 2149 | 4.5 | 269 | 7 | 11 | 18 | 121 | 0.00%  |
| POST /api/v1/onboarding/turn | 2149 | 4.5 | 269 | 8 | 13 | 17 | 42 | 0.00%  |
| POST /api/v1/session | 2149 | 4.5 | 269 | 5 | 14 | 33 | 247 | 0.00%  |
| **Итого** | 32042 | 66.8 | 4005 | 9 | 19 | 31 | 382 | 0.00%  |

dropped_iterations: 0

| Окно (с от старта) | запросов | RPS (TPS) | TPM | p50, мс | p95, мс | p99, мс | max, мс | ошибки |
|---|---|---|---|---|---|---|---|---| dropped |
| 20-80 | 720 | 12.0 | 720 | 12 | 26 | 48 | 260 | 0.00%  | 0 |
| 100-160 | 1680 | 28.0 | 1680 | 13 | 24 | 32 | 148 | 0.00%  | 0 |
| 180-240 | 3000 | 50.0 | 3000 | 10 | 20 | 117 | 382 | 0.00%  | 0 |
| 260-320 | 4559 | 76.0 | 4559 | 9 | 17 | 27 | 209 | 0.00%  | 0 |
| 340-400 | 6059 | 101.0 | 6059 | 10 | 19 | 40 | 205 | 0.00%  | 0 |
| 420-480 | 9031 | 150.5 | 9031 | 9 | 16 | 22 | 140 | 0.00%  | 0 |

## k6 summary

```
  █ THRESHOLDS 
    http_req_duration{flow:analytics}
    ✓ 'p(95)<300' p(95)=17.6ms
    http_req_duration{flow:chat}
    ✓ 'p(95)<500' p(95)=22.02ms
    http_req_duration{flow:health}
    ✓ 'p(95)<200' p(95)=8.49ms
    http_req_duration{flow:onboarding}
    ✓ 'p(95)<500' p(95)=12.93ms
    http_req_duration{flow:page}
    ✓ 'p(95)<200' p(95)=5.75ms
    http_req_duration{flow:sim}
    ✓ 'p(95)<500' p(95)=20.89ms
    http_req_failed
    ✓ 'rate<0.01' rate=0.00%
  █ TOTAL RESULTS 
    checks_total.......: 29893   61.202345/s
    checks_succeeded...: 100.00% 29893 out of 29893
    checks_failed......: 0.00%   0 out of 29893
    ✓ chat 200 + verdict
    ✓ analytics 202
    ✓ sim 200
    ✓ page 200
    ✓ health 200
    ✓ onboarding open 200
    ✓ onboarding turn 200
    HTTP
    http_req_duration..............: avg=10.64ms min=976.36µs med=9.63ms  p(90)=17.16ms p(95)=20.61ms p(99)=31.72ms max=381.56ms
      { expected_response:true }...: avg=10.64ms min=976.36µs med=9.63ms  p(90)=17.16ms p(95)=20.61ms p(99)=31.72ms max=381.56ms
      { flow:analytics }...........: avg=10.88ms min=4.35ms   med=9.22ms  p(90)=15.18ms p(95)=17.6ms  p(99)=34.27ms max=326.28ms
      { flow:chat }................: avg=13.86ms min=5.93ms   med=12.02ms p(90)=18.26ms p(95)=22.02ms p(99)=46.25ms max=381.56ms
      { flow:health }..............: avg=4.74ms  min=2.1ms    med=3.95ms  p(90)=7.26ms  p(95)=8.49ms  p(99)=11.43ms max=154.31ms
      { flow:onboarding }..........: avg=7.74ms  min=2.32ms   med=7ms     p(90)=11.3ms  p(95)=12.93ms p(99)=19.94ms max=246.93ms
      { flow:page }................: avg=2.84ms  min=976.36µs med=2.43ms  p(90)=4.63ms  p(95)=5.75ms  p(99)=9.1ms   max=15.41ms 
      { flow:sim }.................: avg=13.62ms min=6.01ms   med=11.94ms p(90)=18.25ms p(95)=20.89ms p(99)=38.54ms max=327.99ms
    http_req_failed................: 0.00%  0 out of 35042
    http_reqs......................: 35042  71.744307/s
    EXECUTION
    iteration_duration.............: avg=11.96ms min=1.07ms   med=10.69ms p(90)=19.46ms p(95)=23.69ms p(99)=38.68ms max=381.82ms
    iterations.....................: 27744  56.802524/s
    vus............................: 0      min=0          max=14 
    vus_max........................: 120    min=120        max=120
    NETWORK
    data_received..................: 173 MB 355 kB/s
    data_sent......................: 10 MB  21 kB/s
```
