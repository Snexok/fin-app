# iso-health-10rps

Длительность: 61 с

| Эндпоинт | запросов | RPS (TPS) | TPM | p50, мс | p95, мс | p99, мс | max, мс | ошибки |
|---|---|---|---|---|---|---|---|---|
| GET /api/health | 601 | 9.9 | 591 | 3 | 5 | 6 | 12 | 0.00%  |
| **Итого** | 601 | 9.9 | 591 | 3 | 5 | 6 | 12 | 0.00%  |

dropped_iterations: 0

## k6 summary

```
  █ THRESHOLDS 
    http_req_duration{flow:analytics}
    ✓ 'p(95)<300' p(95)=0s
    http_req_duration{flow:chat}
    ✓ 'p(95)<500' p(95)=0s
    http_req_duration{flow:health}
    ✓ 'p(95)<200' p(95)=4.78ms
    http_req_duration{flow:onboarding}
    ✓ 'p(95)<500' p(95)=0s
    http_req_duration{flow:page}
    ✓ 'p(95)<200' p(95)=0s
    http_req_duration{flow:sim}
    ✓ 'p(95)<500' p(95)=0s
    http_req_failed
    ✓ 'rate<0.01' rate=0.00%
  █ TOTAL RESULTS 
    checks_total.......: 601     9.813866/s
    checks_succeeded...: 100.00% 601 out of 601
    checks_failed......: 0.00%   0 out of 601
    ✓ health 200
    HTTP
    http_req_duration..............: avg=9.26ms min=1.66ms med=4.1ms  p(90)=23.14ms p(95)=27.91ms p(99)=31.87ms max=41.19ms
      { expected_response:true }...: avg=9.26ms min=1.66ms med=4.1ms  p(90)=23.14ms p(95)=27.91ms p(99)=31.87ms max=41.19ms
      { flow:analytics }...........: avg=0s     min=0s     med=0s     p(90)=0s      p(95)=0s      p(99)=0s      max=0s     
      { flow:chat }................: avg=0s     min=0s     med=0s     p(90)=0s      p(95)=0s      p(99)=0s      max=0s     
      { flow:health }..............: avg=3.6ms  min=1.66ms med=3.43ms p(90)=4.49ms  p(95)=4.78ms  p(99)=6.02ms  max=12.11ms
      { flow:onboarding }..........: avg=0s     min=0s     med=0s     p(90)=0s      p(95)=0s      p(99)=0s      max=0s     
      { flow:page }................: avg=0s     min=0s     med=0s     p(90)=0s      p(95)=0s      p(99)=0s      max=0s     
      { flow:sim }.................: avg=0s     min=0s     med=0s     p(90)=0s      p(95)=0s      p(99)=0s      max=0s     
    http_req_failed................: 0.00%  0 out of 1001
    http_reqs......................: 1001   16.345557/s
    EXECUTION
    iteration_duration.............: avg=3.86ms min=2.23ms med=3.69ms p(90)=4.77ms  p(95)=5.04ms  p(99)=6.35ms  max=12.36ms
    iterations.....................: 601    9.813866/s
    vus............................: 0      min=0         max=0 
    vus_max........................: 20     min=20        max=20
    NETWORK
    data_received..................: 1.3 MB 22 kB/s
    data_sent......................: 175 kB 2.9 kB/s
```
