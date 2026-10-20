# iso-page-10rps

Длительность: 61 с

| Эндпоинт | запросов | RPS (TPS) | TPM | p50, мс | p95, мс | p99, мс | max, мс | ошибки |
|---|---|---|---|---|---|---|---|---|
| GET / | 601 | 9.9 | 591 | 2 | 3 | 3 | 7 | 0.00%  |
| **Итого** | 601 | 9.9 | 591 | 2 | 3 | 3 | 7 | 0.00%  |

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
    ✓ 'p(95)<200' p(95)=3ms
    http_req_duration{flow:sim}
    ✓ 'p(95)<500' p(95)=0s
    http_req_failed
    ✓ 'rate<0.01' rate=0.00%
  █ TOTAL RESULTS 
    checks_total.......: 601     9.831379/s
    checks_succeeded...: 100.00% 601 out of 601
    checks_failed......: 0.00%   0 out of 601
    ✓ page 200
    HTTP
    http_req_duration..............: avg=7.99ms min=1.42ms med=2.64ms p(90)=19.68ms p(95)=22.98ms p(99)=30.41ms max=42.99ms
      { expected_response:true }...: avg=7.99ms min=1.42ms med=2.64ms p(90)=19.68ms p(95)=22.98ms p(99)=30.41ms max=42.99ms
      { flow:analytics }...........: avg=0s     min=0s     med=0s     p(90)=0s      p(95)=0s      p(99)=0s      max=0s     
      { flow:chat }................: avg=0s     min=0s     med=0s     p(90)=0s      p(95)=0s      p(99)=0s      max=0s     
      { flow:health }..............: avg=0s     min=0s     med=0s     p(90)=0s      p(95)=0s      p(99)=0s      max=0s     
      { flow:onboarding }..........: avg=0s     min=0s     med=0s     p(90)=0s      p(95)=0s      p(99)=0s      max=0s     
      { flow:page }................: avg=2.46ms min=1.42ms med=2.4ms  p(90)=2.8ms   p(95)=3ms     p(99)=3.41ms  max=6.77ms 
      { flow:sim }.................: avg=0s     min=0s     med=0s     p(90)=0s      p(95)=0s      p(99)=0s      max=0s     
    http_req_failed................: 0.00%  0 out of 1001
    http_reqs......................: 1001   16.374727/s
    EXECUTION
    iteration_duration.............: avg=2.73ms min=1.88ms med=2.65ms p(90)=3.05ms  p(95)=3.28ms  p(99)=3.74ms  max=7ms    
    iterations.....................: 601    9.831379/s
    vus............................: 0      min=0         max=0 
    vus_max........................: 20     min=20        max=20
    NETWORK
    data_received..................: 5.7 MB 93 kB/s
    data_sent......................: 169 kB 2.8 kB/s
```
