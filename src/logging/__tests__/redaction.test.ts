import { describe, it, expect } from 'vitest';
import { redactObject, redactString, maskPhone, maskString } from '../redaction';

describe('redaction', () => {
  describe('maskString', () => {
    it('masks middle of string', () => {
      expect(maskString('secret-api-key-12345')).toBe('se****45');
    });

    it('masks short strings completely', () => {
      expect(maskString('abc')).toBe('****');
    });
  });

  describe('maskPhone', () => {
    it('masks phone number preserving prefix and suffix', () => {
      expect(maskPhone('5125550147')).toBe('5125****47');
    });

    it('masks with country code', () => {
      expect(maskPhone('+15125550147')).toBe('+151****47');
    });
  });

  describe('redactString', () => {
    it('masks phone numbers in text', () => {
      const result = redactString('Call me at 5125550147 please');
      expect(result).not.toContain('5125550147');
      expect(result).toContain('****');
    });

    it('masks emails in text', () => {
      const result = redactString('Email: test@example.com');
      expect(result).toContain('****@****.***');
    });
  });

  describe('redactObject', () => {
    it('masks sensitive keys', () => {
      const result = redactObject({
        customer_name: 'Jordan Mitchell',
        phone_number: '5125550147',
        delivery_address: '4821 Elm Street',
        pizza_size: 'large',
      });
      expect(result.customer_name).toBe('Jo****ll');
      expect(result.phone_number).toBe('51****47');
      expect(result.delivery_address).toBe('48****et');
      expect(result.pizza_size).toBe('large'); // not sensitive
    });

    it('handles nested objects', () => {
      const result = redactObject({
        order: {
          customer_name: 'Test User',
          items: ['pizza'],
        },
      });
      expect((result.order as any).customer_name).toBe('Te****er');
      expect((result.order as any).items[0]).toBe('pizza');
    });

    it('handles null and undefined', () => {
      expect(redactObject(null)).toBe(null);
      expect(redactObject(undefined)).toBe(undefined);
    });
  });
});
