# steady-10rps

Длительность: 181 с

| Эндпоинт | запросов | RPS (TPS) | TPM | p50, мс | p95, мс | p99, мс | max, мс | ошибки |
|---|---|---|---|---|---|---|---|---|
| GET / | 181 | 1.0 | 60 | 5 | 9 | 12 | 16 | 0.00%  |
| GET /api/health | 180 | 1.0 | 60 | 7 | 11 | 15 | 21 | 0.00%  |
| POST /api/chat | 541 | 3.0 | 179 | 17 | 25 | 62 | 295 | 0.00%  |
| POST /api/v1/analytics | 271 | 1.5 | 90 | 14 | 21 | 26 | 232 | 0.00%  |
| POST /api/v1/finance/simulations | 270 | 1.5 | 90 | 17 | 25 | 30 | 233 | 0.00%  |
| POST /api/v1/onboarding | 121 | 0.7 | 40 | 7 | 11 | 15 | 31 | 0.00%  |
| POST /api/v1/onboarding/turn | 121 | 0.7 | 40 | 9 | 13 | 16 | 22 | 0.00%  |
| POST /api/v1/session | 121 | 0.7 | 40 | 6 | 8 | 15 | 137 | 0.00%  |
| **Итого** | 1806 | 10.0 | 599 | 13 | 23 | 31 | 295 | 0.00%  |

dropped_iterations: 0

## k6 summary

```
  █ THRESHOLDS 
    http_req_duration{flow:analytics}
    ✓ 'p(95)<300' p(95)=20.79ms
    http_req_duration{flow:chat}
    ✓ 'p(95)<500' p(95)=24.71ms
    http_req_duration{flow:health}
    ✓ 'p(95)<200' p(95)=10.81ms
    http_req_duration{flow:onboarding}
    ✓ 'p(95)<500' p(95)=12.29ms
    http_req_duration{flow:page}
    ✓ 'p(95)<200' p(95)=9.27ms
    http_req_duration{flow:sim}
    ✓ 'p(95)<500' p(95)=25.26ms
    http_req_failed
    ✓ 'rate<0.01' rate=0.00%
  █ TOTAL RESULTS 
    checks_total.......: 1685    9.187982/s
    checks_succeeded...: 100.00% 1685 out of 1685
    checks_failed......: 0.00%   0 out of 1685
    ✓ page 200
    ✓ health 200
    ✓ analytics 202
    ✓ onboarding open 200
    ✓ sim 200
    ✓ chat 200 + verdict
    ✓ onboarding turn 200
    HTTP
    http_req_duration..............: avg=14.75ms min=1.56ms  med=14.33ms p(90)=21.77ms p(95)=24.6ms  p(99)=32.06ms max=295.26ms
      { expected_response:true }...: avg=14.75ms min=1.56ms  med=14.33ms p(90)=21.77ms p(95)=24.6ms  p(99)=32.06ms max=295.26ms
      { flow:analytics }...........: avg=15.55ms min=8.95ms  med=13.95ms p(90)=18.33ms p(95)=20.79ms p(99)=26.35ms max=231.63ms
      { flow:chat }................: avg=19.37ms min=8.51ms  med=17.12ms p(90)=22.72ms p(95)=24.71ms p(99)=62.13ms max=295.26ms
      { flow:health }..............: avg=7.28ms  min=3.33ms  med=6.78ms  p(90)=10.36ms p(95)=10.81ms p(99)=15.39ms max=20.8ms  
      { flow:onboarding }..........: avg=7.98ms  min=3.21ms  med=7.19ms  p(90)=10.3ms  p(95)=12.29ms p(99)=15.73ms max=137.35ms
      { flow:page }................: avg=5.17ms  min=1.56ms  med=4.65ms  p(90)=8.32ms  p(95)=9.27ms  p(99)=11.72ms max=15.54ms 
      { flow:sim }.................: avg=18.81ms min=11.41ms med=16.96ms p(90)=22.08ms p(95)=25.26ms p(99)=29.81ms max=233.12ms
    http_req_failed................: 0.00%  0 out of 3006
    http_reqs......................: 3006   16.391141/s
    EXECUTION
    iteration_duration.............: avg=16.49ms min=2.05ms  med=16.08ms p(90)=22.97ms p(95)=25.6ms  p(99)=33.79ms max=295.79ms
    iterations.....................: 1564   8.528192/s
    vus............................: 0      min=0         max=1  
    vus_max........................: 120    min=120       max=120
    NETWORK
    data_received..................: 12 MB  65 kB/s
    data_sent......................: 899 kB 4.9 kB/s
```
