# iso-chat-10rps

Длительность: 61 с

| Эндпоинт | запросов | RPS (TPS) | TPM | p50, мс | p95, мс | p99, мс | max, мс | ошибки |
|---|---|---|---|---|---|---|---|---|
| POST /api/chat | 601 | 9.9 | 591 | 13 | 17 | 100 | 292 | 0.00%  |
| **Итого** | 601 | 9.9 | 591 | 13 | 17 | 100 | 292 | 0.00%  |

dropped_iterations: 0

## k6 summary

```
  █ THRESHOLDS 
    http_req_duration{flow:analytics}
    ✓ 'p(95)<300' p(95)=0s
    http_req_duration{flow:chat}
    ✓ 'p(95)<500' p(95)=17ms
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
    checks_total.......: 601     9.814598/s
    checks_succeeded...: 100.00% 601 out of 601
    checks_failed......: 0.00%   0 out of 601
    ✓ chat 200 + verdict
    HTTP
    http_req_duration..............: avg=16.47ms min=5.34ms med=13.65ms p(90)=22.64ms p(95)=25.78ms p(99)=60.9ms  max=291.71ms
      { expected_response:true }...: avg=16.47ms min=5.34ms med=13.65ms p(90)=22.64ms p(95)=25.78ms p(99)=60.9ms  max=291.71ms
      { flow:analytics }...........: avg=0s      min=0s     med=0s      p(90)=0s      p(95)=0s      p(99)=0s      max=0s      
      { flow:chat }................: avg=15.68ms min=9.28ms med=13.24ms p(90)=15.57ms p(95)=17ms    p(99)=99.5ms  max=291.71ms
      { flow:health }..............: avg=0s      min=0s     med=0s      p(90)=0s      p(95)=0s      p(99)=0s      max=0s      
      { flow:onboarding }..........: avg=0s      min=0s     med=0s      p(90)=0s      p(95)=0s      p(99)=0s      max=0s      
      { flow:page }................: avg=0s      min=0s     med=0s      p(90)=0s      p(95)=0s      p(99)=0s      max=0s      
      { flow:sim }.................: avg=0s      min=0s     med=0s      p(90)=0s      p(95)=0s      p(99)=0s      max=0s      
    http_req_failed................: 0.00%  0 out of 1001
    http_reqs......................: 1001   16.346776/s
    EXECUTION
    iteration_duration.............: avg=16.06ms min=9.61ms med=13.58ms p(90)=15.97ms p(95)=17.47ms p(99)=99.88ms max=292.07ms
    iterations.....................: 601    9.814598/s
    vus............................: 0      min=0         max=2 
    vus_max........................: 20     min=20        max=20
    NETWORK
    data_received..................: 8.0 MB 130 kB/s
    data_sent......................: 323 kB 5.3 kB/s
```
