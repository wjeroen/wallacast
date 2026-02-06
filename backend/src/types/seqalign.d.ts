declare module 'seqalign' {
  export class NWaligner {
    constructor(
      seq1: string[],
      seq2: string[],
      options?: {
        similarity?: (a: string, b: string) => number;
        gapPenalty?: number;
      }
    );
    align(): Array<[number, number]>;
  }
}
