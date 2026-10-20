# iso-sim-10rps

Длительность: 61 с

| Эндпоинт | запросов | RPS (TPS) | TPM | p50, мс | p95, мс | p99, мс | max, мс | ошибки |
|---|---|---|---|---|---|---|---|---|
| POST /api/v1/finance/simulations | 601 | 9.9 | 591 | 12 | 15 | 68 | 137 | 0.00%  |
| **Итого** | 601 | 9.9 | 591 | 12 | 15 | 68 | 137 | 0.00%  |

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
    ✓ 'p(95)<500' p(95)=0s
    http_req_duration{flow:page}
    ✓ 'p(95)<200' p(95)=0s
    http_req_duration{flow:sim}
    ✓ 'p(95)<500' p(95)=15.24ms
    http_req_failed
    ✓ 'rate<0.01' rate=0.00%
  █ TOTAL RESULTS 
    checks_total.......: 601     9.828184/s
    checks_succeeded...: 100.00% 601 out of 601
    checks_failed......: 0.00%   0 out of 601
    ✓ sim 200
    HTTP
    http_req_duration..............: avg=14.54ms min=4.03ms med=12.46ms p(90)=21.55ms p(95)=24.65ms p(99)=35.46ms max=136.78ms
      { expected_response:true }...: avg=14.54ms min=4.03ms med=12.46ms p(90)=21.55ms p(95)=24.65ms p(99)=35.46ms max=136.78ms
      { flow:analytics }...........: avg=0s      min=0s     med=0s      p(90)=0s      p(95)=0s      p(99)=0s      max=0s      
      { flow:chat }................: avg=0s      min=0s     med=0s      p(90)=0s      p(95)=0s      p(99)=0s      max=0s      
      { flow:health }..............: avg=0s      min=0s     med=0s      p(90)=0s      p(95)=0s      p(99)=0s      max=0s      
      { flow:onboarding }..........: avg=0s      min=0s     med=0s      p(90)=0s      p(95)=0s      p(99)=0s      max=0s      
      { flow:page }................: avg=0s      min=0s     med=0s      p(90)=0s      p(95)=0s      p(99)=0s      max=0s      
      { flow:sim }.................: avg=13.25ms min=7.55ms med=11.96ms p(90)=13.9ms  p(95)=15.24ms p(99)=68.41ms max=136.78ms
    http_req_failed................: 0.00%  0 out of 1001
    http_reqs......................: 1001   16.369404/s
    EXECUTION
    iteration_duration.............: avg=13.59ms min=8.15ms med=12.29ms p(90)=14.22ms p(95)=15.58ms p(99)=68.84ms max=137.03ms
    iterations.....................: 601    9.828184/s
    vus............................: 0      min=0         max=0 
    vus_max........................: 20     min=20        max=20
    NETWORK
    data_received..................: 2.3 MB 37 kB/s
    data_sent......................: 379 kB 6.2 kB/s
```
