# iso-onboarding-10rps

Длительность: 60 с

| Эндпоинт | запросов | RPS (TPS) | TPM | p50, мс | p95, мс | p99, мс | max, мс | ошибки |
|---|---|---|---|---|---|---|---|---|
| POST /api/v1/onboarding | 200 | 3.3 | 200 | 7 | 10 | 13 | 14 | 0.00%  |
| POST /api/v1/onboarding/turn | 200 | 3.3 | 200 | 8 | 12 | 14 | 15 | 0.00%  |
| POST /api/v1/session | 200 | 3.3 | 200 | 7 | 9 | 103 | 154 | 0.00%  |
| **Итого** | 600 | 10.0 | 600 | 7 | 11 | 14 | 154 | 0.00%  |

dropped_iterations: 0

## k6 summary

```
  █ THRESHOLDS 
    http_req_duration{flow:analytics}
    ✓ 'p(95)<300' p(95)=0s
    http_req_duration{flow:chat}
    ✓ 'p(95)<500' p(95)=0s
    http_req_duration{flow:health}
    ✓ 'p(95)<200' p(95)=0s
    http_req_duration{flow:onboarding}
    ✓ 'p(95)<500' p(95)=11.11ms
    http_req_duration{flow:page}
    ✓ 'p(95)<200' p(95)=0s
    http_req_duration{flow:sim}
    ✓ 'p(95)<500' p(95)=0s
    http_req_failed
    ✓ 'rate<0.01' rate=0.00%
  █ TOTAL RESULTS 
    checks_total.......: 400     6.51402/s
    checks_succeeded...: 100.00% 400 out of 400
    checks_failed......: 0.00%   0 out of 400
    ✓ onboarding open 200
    ✓ onboarding turn 200
    HTTP
    http_req_duration..............: avg=13.04ms min=3.1ms   med=8.85ms  p(90)=21.48ms p(95)=25.2ms  p(99)=52.77ms  max=231.91ms
      { expected_response:true }...: avg=13.04ms min=3.1ms   med=8.85ms  p(90)=21.48ms p(95)=25.2ms  p(99)=52.77ms  max=231.91ms
      { flow:analytics }...........: avg=0s      min=0s      med=0s      p(90)=0s      p(95)=0s      p(99)=0s       max=0s      
      { flow:chat }................: avg=0s      min=0s      med=0s      p(90)=0s      p(95)=0s      p(99)=0s       max=0s      
      { flow:health }..............: avg=0s      min=0s      med=0s      p(90)=0s      p(95)=0s      p(99)=0s       max=0s      
      { flow:onboarding }..........: avg=8.13ms  min=3.1ms   med=7.22ms  p(90)=10.05ms p(95)=11.11ms p(99)=14.32ms  max=154.19ms
      { flow:page }................: avg=0s      min=0s      med=0s      p(90)=0s      p(95)=0s      p(99)=0s       max=0s      
      { flow:sim }.................: avg=0s      min=0s      med=0s      p(90)=0s      p(95)=0s      p(99)=0s       max=0s      
    http_req_failed................: 0.00%  0 out of 1000
    http_reqs......................: 1000   16.28505/s
    EXECUTION
    iteration_duration.............: avg=25.08ms min=15.44ms med=22.73ms p(90)=27.99ms p(95)=30.15ms p(99)=117.69ms max=173.62ms
    iterations.....................: 200    3.25701/s
    vus............................: 0      min=0         max=0 
    vus_max........................: 20     min=20        max=20
    NETWORK
    data_received..................: 1.7 MB 28 kB/s
    data_sent......................: 275 kB 4.5 kB/s
```
