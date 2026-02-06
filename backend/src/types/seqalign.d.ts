declare module 'seqalign' {
  // Factory function that returns an aligner object
  export function NWaligner(
    seq1: string[],
    seq2: string[],
    options?: {
      similarity?: (a: string, b: string) => number;
      gapPenalty?: number;
    }
  ): {
    align(): Array<[number, number]>;
  };
}
