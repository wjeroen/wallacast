declare module 'seqalign' {
  // Factory function that returns an aligner object
  export function NWaligner(options?: {
    similarityScoreFunction?: (a: string, b: string) => number;
    gapScoreFunction?: () => number;
    gapSymbol?: string;
  }): {
    align(seq1: string[], seq2: string[]): {
      score: number;
      originalSequences: string[];
      alignedSequences: string[];
      coordinateWalk: Array<[number, number]>;
      scoringMatrix: number[][];
      tracebackMatrix: number[][];
      alignment: string;
    };
  };
}
