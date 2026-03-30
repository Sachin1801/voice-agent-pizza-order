import { describe, it, expect } from 'vitest';

// Import the normalizer by testing it through the module
// Since normalizeForSpeech is a module-level function, we need to export it or test via speak()
// For now, duplicate the logic here for direct unit testing

function normalizeForSpeech(text: string): string {
  return text
    .replace(/\b(\d{3})(\d{3})(\d{4})\b/g, '$1-$2-$3')
    .replace(/\b(\d+)L\b/g, '$1 liter')
    .replace(/\b(\d+)\s*oz\b/gi, '$1 ounce')
    .replace(/\bApt\b/g, 'Apartment')
    .replace(/\bSt\b(?=\s+\d)/g, 'Street')
    .replace(/\bAve\b/g, 'Avenue')
    .replace(/\bBlvd\b/g, 'Boulevard')
    .replace(/(?<=\d\s)Dr\b/g, 'Drive')
    .replace(/\bTX\b/g, 'Texas')
    .replace(/\bCA\b/g, 'California')
    .replace(/\bNY\b/g, 'New York')
    .replace(/\bFL\b/g, 'Florida')
    .replace(/\b(\d+)\s*ct\b/gi, '$1 count')
    .replace(/\b(thank you)\s*,?\s*(goodbye|bye|have a good|take care)/gi, '$1. ... $2');
}

describe('normalizeForSpeech', () => {
  it('converts volume abbreviations', () => {
    expect(normalizeForSpeech('2L Coke')).toBe('2 liter Coke');
    expect(normalizeForSpeech('2L Pepsi')).toBe('2 liter Pepsi');
  });

  it('converts ounce abbreviations', () => {
    expect(normalizeForSpeech('16oz')).toBe('16 ounce');
    expect(normalizeForSpeech('12 oz')).toBe('12 ounce');
  });

  it('converts Apt to Apartment', () => {
    expect(normalizeForSpeech('Apt 3B')).toBe('Apartment 3B');
  });

  it('converts street abbreviations', () => {
    expect(normalizeForSpeech('Elm St 100')).toBe('Elm Street 100');
    expect(normalizeForSpeech('Main Ave')).toBe('Main Avenue');
    expect(normalizeForSpeech('Sunset Blvd')).toBe('Sunset Boulevard');
  });

  it('converts Dr to Drive only after numbers', () => {
    expect(normalizeForSpeech('100 Dr')).toBe('100 Drive');
    // Should NOT convert "Dr Smith" (doctor title)
    expect(normalizeForSpeech('Dr Smith')).toBe('Dr Smith');
  });

  it('converts state abbreviations', () => {
    expect(normalizeForSpeech('Austin, TX 78745')).toBe('Austin, Texas 78745');
    expect(normalizeForSpeech('Los Angeles, CA')).toBe('Los Angeles, California');
    expect(normalizeForSpeech('New York, NY')).toBe('New York, New York');
    expect(normalizeForSpeech('Miami, FL')).toBe('Miami, Florida');
  });

  it('converts count abbreviation', () => {
    expect(normalizeForSpeech('12ct')).toBe('12 count');
    expect(normalizeForSpeech('12 ct')).toBe('12 count');
  });

  it('handles full address normalization', () => {
    expect(normalizeForSpeech('4821 Elm St 100, Apt 3B, Austin, TX 78745'))
      .toBe('4821 Elm Street 100, Apartment 3B, Austin, Texas 78745');
  });

  it('formats 10-digit phone numbers with dashes', () => {
    expect(normalizeForSpeech('5125550147')).toBe('512-555-0147');
    expect(normalizeForSpeech('The phone number is 5125550147')).toBe('The phone number is 512-555-0147');
  });

  it('does not format non-10-digit number sequences', () => {
    expect(normalizeForSpeech('78745')).toBe('78745');
    expect(normalizeForSpeech('4412')).toBe('4412');
  });

  it('adds pause before farewell words', () => {
    expect(normalizeForSpeech('Thank you, goodbye.')).toBe('Thank you. ... goodbye.');
    expect(normalizeForSpeech('Thank you goodbye')).toBe('Thank you. ... goodbye');
    expect(normalizeForSpeech('Thank you, bye.')).toBe('Thank you. ... bye.');
    expect(normalizeForSpeech('Thank you, have a good one')).toBe('Thank you. ... have a good one');
  });

  it('does not add pause when thank you is not followed by farewell', () => {
    expect(normalizeForSpeech('Thank you for the order')).toBe('Thank you for the order');
  });

  it('leaves normal text unchanged', () => {
    expect(normalizeForSpeech('Hi, I would like to place a delivery order'))
      .toBe('Hi, I would like to place a delivery order');
  });
});
