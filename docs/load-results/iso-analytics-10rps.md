# iso-analytics-10rps

Длительность: 61 с

| Эндпоинт | запросов | RPS (TPS) | TPM | p50, мс | p95, мс | p99, мс | max, мс | ошибки |
|---|---|---|---|---|---|---|---|---|
| POST /api/v1/analytics | 601 | 9.9 | 591 | 9 | 12 | 25 | 138 | 0.00%  |
| **Итого** | 601 | 9.9 | 591 | 9 | 12 | 25 | 138 | 0.00%  |

dropped_iterations: 0

## k6 summary

```
  █ THRESHOLDS 
    http_req_duration{flow:analytics}
    ✓ 'p(95)<300' p(95)=11.91ms
    http_req_duration{flow:chat}
    ✓ 'p(95)<500' p(95)=0s
    http_req_duration{flow:health}
    ✓ 'p(95)<200' p(95)=0s
    http_req_duration{flow:onboarding}
    ✓ 'p(95)<500' p(95)=0s
    http_req_duration{flow:page}
    ✓ 'p(95)<200' p(95)=0s
    http_req_duration{flow:sim}
    ✓ 'p(95)<500' p(95)=0s
    http_req_failed
    ✓ 'rate<0.01' rate=0.00%
  █ TOTAL RESULTS 
    checks_total.......: 601     9.840391/s
    checks_succeeded...: 100.00% 601 out of 601
    checks_failed......: 0.00%   0 out of 601
    ✓ analytics 202
    HTTP
    http_req_duration..............: avg=12.12ms min=4.52ms med=9.86ms p(90)=19.37ms p(95)=22.79ms p(99)=28.45ms max=138.49ms
      { expected_response:true }...: avg=12.12ms min=4.52ms med=9.86ms p(90)=19.37ms p(95)=22.79ms p(99)=28.45ms max=138.49ms
      { flow:analytics }...........: avg=9.98ms  min=5.82ms med=9.19ms p(90)=10.98ms p(95)=11.91ms p(99)=24.53ms max=138.49ms
      { flow:chat }................: avg=0s      min=0s     med=0s     p(90)=0s      p(95)=0s      p(99)=0s      max=0s      
      { flow:health }..............: avg=0s      min=0s     med=0s     p(90)=0s      p(95)=0s      p(99)=0s      max=0s      
      { flow:onboarding }..........: avg=0s      min=0s     med=0s     p(90)=0s      p(95)=0s      p(99)=0s      max=0s      
      { flow:page }................: avg=0s      min=0s     med=0s     p(90)=0s      p(95)=0s      p(99)=0s      max=0s      
      { flow:sim }.................: avg=0s      min=0s     med=0s     p(90)=0s      p(95)=0s      p(99)=0s      max=0s      
    http_req_failed................: 0.00%  0 out of 1001
    http_reqs......................: 1001   16.389736/s
    EXECUTION
    iteration_duration.............: avg=10.34ms min=6.13ms med=9.54ms p(90)=11.36ms p(95)=12.38ms p(99)=24.9ms  max=138.81ms
    iterations.....................: 601    9.840391/s
    vus............................: 0      min=0         max=0 
    vus_max........................: 20     min=20        max=20
    NETWORK
    data_received..................: 1.4 MB 22 kB/s
    data_sent......................: 375 kB 6.1 kB/s
```
