import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  iterations: 50,
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<60000'],
  },
};

export default function () {
  const res = http.post('http://localhost:8081/invoke', JSON.stringify({
    prompt: 'Say OK.',
  }), { headers: { 'Content-Type': 'application/json' }, timeout: '120s' });

  check(res, {
    'status 200': (r) => r.status === 200,
    'has output': (r) => JSON.parse(r.body).output.length > 0,
  });
  sleep(1);
}
