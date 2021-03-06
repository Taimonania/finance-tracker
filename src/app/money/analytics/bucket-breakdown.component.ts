import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { ChartData, ChartDataSets } from 'chart.js';
import { KeyedArrayAggregate } from 'src/app/core/keyed-aggregate';
import { MONEY_EPSILON } from '../model-util';
import { BilledTransaction } from './analytics.component';

@Component({
  selector: 'app-bucket-breakdown',
  templateUrl: './bucket-breakdown.component.html',
  styleUrls: ['./bucket-breakdown.component.css']
})
export class BucketBreakdownComponent implements OnChanges {
  @Input()
  billedTransactionBuckets: KeyedArrayAggregate<BilledTransaction>;

  /** Emits the name of a bucket when the user clicks on it. */
  @Output()
  bucketClick = new EventEmitter<string>();
  /** Same as bucketClick, but emitted when user clicks while holding alt key. */
  @Output()
  bucketAltClick = new EventEmitter<string>();

  buckets: BucketInfo[] = [];
  aggregateBuckets: BucketInfo[] = [];
  monthlyChartData: ChartData = {};

  ngOnChanges(changes: SimpleChanges) {
    this.analyzeMonthlyBreakdown();
  }

  onBucketClick(bucketIndex: number, isAlt: boolean) {
    // e.g. '2018-01'
    const bucketName = String(this.monthlyChartData.labels![bucketIndex]);
    if (isAlt) {
      this.bucketAltClick.emit(bucketName);
    } else {
      this.bucketClick.emit(bucketName);
    }
  }

  private analyzeMonthlyBreakdown() {
    this.buckets = [];
    for (const [key, billedTransactions] of this.billedTransactionBuckets.getEntriesSorted()) {
      const positive = billedTransactions.filter(t => t.amount > MONEY_EPSILON);
      const negative = billedTransactions.filter(t => t.amount < -MONEY_EPSILON);

      this.buckets.push({
        name: key,
        numTransactions: billedTransactions.length,
        totalPositive: positive.map(t => t.amount).reduce((a, b) => a + b, 0),
        totalNegative: negative.map(t => t.amount).reduce((a, b) => a + b, 0),
      });
    }

    const datasets: ChartDataSets[] = [];
    if (this.buckets.some(b => b.totalNegative !== 0))
      datasets.push({ data: this.buckets.map(b => -b.totalNegative), label: 'Expenses', backgroundColor: 'red' });
    if (this.buckets.some(b => b.totalPositive !== 0))
      datasets.push({ data: this.buckets.map(b => b.totalPositive), label: 'Income', backgroundColor: 'blue' });

    this.monthlyChartData = {
      labels: this.buckets.map(b => b.name),
      datasets,
    };

    // Calculate mean and median.
    const aggNames = ['Total', 'Mean', 'Median'];
    const aggPos = this.calculateTotalMeanMedian(this.buckets.map(b => b.totalPositive));
    const aggNeg = this.calculateTotalMeanMedian(this.buckets.map(b => b.totalNegative));
    const aggNum = this.calculateTotalMeanMedian(this.buckets.map(b => b.numTransactions));

    this.aggregateBuckets = aggNames.map((name, i) => ({
      name,
      totalPositive: aggPos[i],
      totalNegative: aggNeg[i],
      numTransactions: aggNum[i],
    }));
  }

  private calculateTotalMeanMedian(numbers: number[]): [number, number, number] {
    if (numbers.length === 0) return [NaN, NaN, NaN];
    const total = numbers.reduce((a, b) => a + b, 0);
    const mean = total / numbers.length;

    let median: number;
    const sorted = numbers.slice(0).sort((a, b) => a - b);
    if (sorted.length % 2 === 0) {
      median = (sorted[(sorted.length >> 1) - 1] + sorted[sorted.length >> 1]) / 2;
    } else {
      median = sorted[sorted.length >> 1];
    }
    return [total, mean, median];
  }

}

/** Contains aggregate data about a date bucket. */
export interface BucketInfo {
  name: string;
  numTransactions: number;
  totalPositive: number;
  totalNegative: number;
}
