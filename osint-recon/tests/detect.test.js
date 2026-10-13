'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectInputType, validateForcedType, isValidIPv4 } = require('../src/detect');

test('spec sample inputs map to the expected types', () => {
  assert.equal(detectInputType('test@example.com').type, 'email');
  assert.equal(detectInputType('torvalds').type, 'username');
  assert.equal(detectInputType('8.8.8.8').type, 'ip');
  assert.equal(detectInputType('example.com').type, 'domain');
  assert.equal(detectInputType('+1 555 123 4567').type, 'phone');
  assert.equal(detectInputType('(555) 123-4567').type, 'phone');
  assert.equal(detectInputType('John Smith').type, 'name');
});

test('overlapping matches are reported as candidates, primary first', () => {
  // "example.com" matches both the domain and username patterns; domain wins.
  const domain = detectInputType('example.com');
  assert.deepEqual(domain.candidates, ['domain', 'username']);

  const digits = detectInputType('1234567890');
  assert.equal(digits.type, 'phone');
  assert.deepEqual(digits.candidates, ['phone', 'username']);

  assert.deepEqual(detectInputType('test@example.com').candidates, ['email']);
});

test('IPv4 octets above 255 are rejected', () => {
  assert.equal(isValidIPv4('255.255.255.255'), true);
  assert.equal(isValidIPv4('999.1.1.1'), false);
  assert.notEqual(detectInputType('999.1.1.1').type, 'ip');
});

test('multi-label domains are detected', () => {
  assert.equal(detectInputType('sub.example.co.uk').type, 'domain');
});

test('emails and domains are lowercased, other types keep their case', () => {
  assert.equal(detectInputType('  Test@Example.COM ').query, 'test@example.com');
  assert.equal(detectInputType('Example.COM').query, 'example.com');
  assert.equal(detectInputType('TorVaLds').query, 'TorVaLds');
});

test('whitespace is collapsed and trimmed', () => {
  assert.equal(detectInputType('   John    Smith  ').query, 'John Smith');
});

test('unrecognised input returns a null type', () => {
  assert.equal(detectInputType('').type, null);
  assert.equal(detectInputType('a').type, null);
  assert.equal(detectInputType('hello world!').type, null);
  assert.equal(detectInputType('https://example.com/path').type, null);
});

test('forced types are validated against the input', () => {
  assert.equal(validateForcedType('username', 'john.doe'), 'john.doe');
  assert.equal(validateForcedType('email', 'not-an-email'), null);
  assert.equal(validateForcedType('ip', 'example.com'), null);
  assert.equal(validateForcedType('bogus', 'example.com'), null);
  assert.equal(validateForcedType('domain', 'EXAMPLE.com'), 'example.com');
});
