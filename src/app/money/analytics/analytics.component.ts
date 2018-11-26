import { Component, OnDestroy, OnInit } from '@angular/core';
import { ChartData, ChartDataSets } from 'chart.js';
import * as moment from 'moment';
import { BehaviorSubject, combineLatest, Subscription } from 'rxjs';
import { map } from 'rxjs/operators';
import { BillingInfo, BillingType, Date as ProtoDate, Transaction } from '../../../proto/model';
import { KeyedArrayAggregate, KeyedNumberAggregate } from '../../core/keyed-aggregate';
import { protoDateToMoment, timestampToMoment, timestampToWholeSeconds } from '../../core/proto-util';
import { maxBy } from '../../core/util';
import { DataService } from '../data.service';
import { DialogService } from '../dialog.service';
import { FilterState } from '../filter-input/filter-state';
import { extractAllLabels, getCanonicalBilling, getTransactionAmount, isSingle } from '../model-util';
import { TransactionFilterService } from '../transaction-filter.service';
import { LabelDominanceOrder } from './dialog-label-dominance/dialog-label-dominance.component';

/** The character that is used in label names to define a hierarchy. */
export const LABEL_HIERARCHY_SEPARATOR = '/';

@Component({
  selector: 'app-analytics',
  templateUrl: './analytics.component.html',
  styleUrls: ['./analytics.component.css']
})
export class AnalyticsComponent implements OnInit, OnDestroy {
  // TODO Split this component into multiple parts, possibly add "AnalyticsService" for shared functionality.

  readonly filterState = new FilterState();
  readonly averageOver3MonthsSubject = new BehaviorSubject<boolean>(false);
  readonly labelCollapseSubject = new BehaviorSubject<void>(void (0));
  private readonly labelDominanceSubject = new BehaviorSubject<LabelDominanceOrder>({});

  private static readonly uncollapsedLabels = new Set<string>();
  labelGroups: LabelGroup[] = [];

  matchingTransactions: Transaction[] = []; // This is the dataset that child components operate on.
  totalTransactionCount = 0;
  matchingTransactionCount = 0;
  buckets: BucketInfo[] = [];
  maxBucketExpense = 0;
  monthlyChartData: ChartData = {};
  monthlyMeanBucket: Partial<BucketInfo> = {};
  monthlyMedianBucket: Partial<BucketInfo> = {};

  private txSubscription: Subscription;

  constructor(
    private readonly dataService: DataService,
    private readonly filterService: TransactionFilterService,
    private readonly dialogService: DialogService) { }

  ngOnInit() {
    this.dataService.userSettings$
      .pipe(map(settings => settings.labelDominanceOrder))
      .subscribe(this.labelDominanceSubject);

    this.labelCollapseSubject.subscribe(() => this.refreshUncollapsedLabels());

    this.txSubscription =
      combineLatest(
        this.dataService.transactions$,
        this.filterState.value$,
        this.averageOver3MonthsSubject,
        this.labelCollapseSubject,
        this.labelDominanceSubject)
        .subscribe(([_, filterValue, useAverage, __, ___]) => this.analyzeTransactions(filterValue, useAverage));
  }

  ngOnDestroy() {
    this.txSubscription.unsubscribe();
  }

  onChartBucketClick(monthIndex: number) {
    // e.g. '2018-01'
    const bucketName = this.monthlyChartData.labels![monthIndex];

    // TODO Refactor token operations into some utility method.
    const addedToken = 'date:' + bucketName;
    let newFilter = this.filterState.getCurrentValue();
    if (newFilter.length > 0) {
      newFilter += " " + addedToken;
    } else {
      newFilter = addedToken;
    }
    this.filterState.setValueNow(newFilter);
  }

  collapseAllGroups() {
    AnalyticsComponent.uncollapsedLabels.clear();
    this.labelGroups.forEach(group => group.shouldCollapse = true);
    this.labelCollapseSubject.next(void (0));
  }

  uncollapseAllGroups() {
    this.labelGroups.forEach(group => group.shouldCollapse = false);
    this.labelCollapseSubject.next(void (0));
  }

  openLabelDominanceDialog() {
    const originalDominanceOrder = this.labelDominanceSubject.getValue();
    const dominanceOrder = Object.assign({}, originalDominanceOrder);

    this.dialogService.openAnalyticsLabelDominance(dominanceOrder)
      .afterConfirmed().subscribe(() => {
        this.dataService.getUserSettings().labelDominanceOrder = dominanceOrder;
        this.labelDominanceSubject.next(dominanceOrder);
      });
  }

  private analyzeTransactions(filterValue: string, useAverage: boolean) {
    const allTransactions = this.dataService.getCurrentTransactionList();
    this.matchingTransactions = this.filterService.applyFilter(allTransactions, filterValue);
    this.totalTransactionCount = allTransactions.length;
    this.matchingTransactionCount = this.matchingTransactions.length;

    this.analyzeLabelGroups();
    this.analyzeMonthlyBreakdown(useAverage);
  }

  private refreshUncollapsedLabels() {
    for (const group of this.labelGroups) {
      if (group.shouldCollapse) {
        AnalyticsComponent.uncollapsedLabels.delete(group.parentName);
      } else {
        AnalyticsComponent.uncollapsedLabels.add(group.parentName);
      }
    }
  }

  private analyzeLabelGroups() {
    const labels = extractAllLabels(this.matchingTransactions);
    const parentLabels = new KeyedArrayAggregate<string>();
    for (const label of labels) {
      const sepIndex = label.indexOf(LABEL_HIERARCHY_SEPARATOR);
      if (sepIndex > 0) {
        parentLabels.add(label.substr(0, sepIndex), label.substr(sepIndex + 1));
      } else {
        // Just a regular label, but it may be a parent to some other children.
        parentLabels.add(label, label);
      }
    }

    this.labelGroups = parentLabels.getEntries()
      .filter(entry => entry[1].length > 1)
      .map(entry => <LabelGroup>{
        parentName: entry[0],
        children: entry[1],
        shouldCollapse: !AnalyticsComponent.uncollapsedLabels.has(entry[0]),
      });
  }

  private analyzeMonthlyBreakdown(useAverage: boolean) {
    const displayUnit = 'month';
    const keyFormat = 'YYYY-MM';

    const transactionBuckets = new KeyedArrayAggregate<BilledTransaction>();

    const debugContribHistogram = new KeyedNumberAggregate();
    for (const transaction of this.matchingTransactions) {
      const dateMoment = timestampToMoment(isSingle(transaction)
        ? transaction.single.date
        : maxBy(transaction.group!.children, child => timestampToWholeSeconds(child.date))!.date
      );

      // DEBUG: enforce some example billing data
      if (transaction.labels.includes('car/fuel')) {
        transaction.billing = new BillingInfo({
          periodType: BillingType.MONTH,
          isRelative: true,
          date: new ProtoDate({ year: 0, month: -2 }),
          endDate: new ProtoDate({ year: 0, month: 0 }),
        });
      }
      else if (transaction.labels.includes('university') || transaction.labels.includes('transport/semesterticket')) {
        transaction.billing = new BillingInfo({
          periodType: BillingType.MONTH,
          isRelative: true,
          date: new ProtoDate({ year: 0, month: 0 }),
          endDate: new ProtoDate({ year: 0, month: 5 }),
          isPeriodic: true,
        });
      }
      else if (transaction.labels.includes('scholarship')) {
        transaction.billing = new BillingInfo({
          periodType: BillingType.MONTH,
          isRelative: true,
          date: new ProtoDate({ year: 0, month: 0 }),
          endDate: new ProtoDate({ year: 0, month: 2 }),
          isPeriodic: true,
        });
      }
      else if (transaction.labels.includes('car/maintenance')) {
        transaction.billing = new BillingInfo({
          periodType: BillingType.YEAR,
        });
      }
      else if (transaction.labels.includes('convention')) {
        transaction.billing = new BillingInfo({
          periodType: BillingType.DAY,
          date: new ProtoDate({ year: 2018, month: 8, day: 20 }),
          endDate: new ProtoDate({ year: 2018, month: 9, day: 1 }),
        });
      }

      let fromMoment: moment.Moment;
      let toMoment: moment.Moment;
      if (transaction.billing) {
        // TODO inherit billing from labels.
        const billing = getCanonicalBilling(transaction.billing, dateMoment);
        fromMoment = protoDateToMoment(billing.date);
        toMoment = protoDateToMoment(billing.endDate);

        // For now, we just have to adjust YEAR granularity down to month,
        // in the future adjust this to always spread to at least displayUnit granularity.
        if (billing.periodType === BillingType.YEAR) {
          fromMoment.month(0);
          toMoment.month(11);
        }

        // TODO: Handle "billing.isPeriodic".
      } else {
        fromMoment = dateMoment;
        toMoment = dateMoment;
      }

      const contributingKeys: string[] = [];
      // Iterate over date units and collect their keys.
      // Start with the normalized version of fromMoment (e.g. for months,
      // 2018-05-22 is turned into 2018-05-01).
      const it = moment(fromMoment.format(keyFormat), keyFormat);
      while (it.isSameOrBefore(toMoment)) {
        contributingKeys.push(it.format(keyFormat));
        it.add(1, displayUnit);
      }

      debugContribHistogram.add(contributingKeys.length + "", 1);

      // TODO: For DAY billing granularity, we may want to consider proportional contributions to the months.
      const amountPerBucket = getTransactionAmount(transaction) / contributingKeys.length;
      for (const key of contributingKeys) {
        transactionBuckets.add(key, {
          source: transaction,
          relevantLabels: transaction.labels,
          amount: amountPerBucket,
        });
      }
    }

    console.log(debugContribHistogram.getEntries());

    // Fill holes in transactionBuckets with empty buckets.
    // Sort the keys alphanumerically as the keyFormat is big-endian.
    const sortedKeys = transactionBuckets.getKeys().sort();
    if (sortedKeys.length > 1) {
      const last = sortedKeys[sortedKeys.length - 1];
      const it = moment(sortedKeys[0]);
      while (it.isBefore(last)) {
        it.add(1, displayUnit);
        // Make sure each date unit (e.g. month) is represented as a bucket.
        transactionBuckets.addMany(it.format(keyFormat), []);
      }
    }

    this.buckets = [];
    for (const [key, billedTransactions] of transactionBuckets.getEntriesSorted()) {
      const positive = billedTransactions.filter(t => t.amount > 0);
      const negative = billedTransactions.filter(t => t.amount < 0);

      this.buckets.push({
        name: key,
        numTransactions: billedTransactions.length,
        totalPositive: positive.map(t => t.amount).reduce((a, b) => a + b, 0),
        totalNegative: negative.map(t => t.amount).reduce((a, b) => a + b, 0),
      });
    }

    if (!useAverage) {
      this.maxBucketExpense = -Math.min(...this.buckets.map(b => b.totalNegative));
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
    const [meanPositive, medianPositive] = this.calculateMeanAndMedian(this.buckets.map(b => b.totalPositive));
    const [meanNegative, medianNegative] = this.calculateMeanAndMedian(this.buckets.map(b => b.totalNegative));
    const [meanNum, medianNum] = this.calculateMeanAndMedian(this.buckets.map(b => b.numTransactions));
    this.monthlyMeanBucket.totalPositive = meanPositive;
    this.monthlyMeanBucket.totalNegative = meanNegative;
    this.monthlyMeanBucket.numTransactions = meanNum;
    this.monthlyMedianBucket.totalPositive = medianPositive;
    this.monthlyMedianBucket.totalNegative = medianNegative;
    this.monthlyMedianBucket.numTransactions = medianNum;
  }

  private calculateMeanAndMedian(numbers: number[]): [number, number] {
    if (numbers.length === 0) return [NaN, NaN];
    const mean = numbers.reduce((a, b) => a + b, 0) / numbers.length;

    let median: number;
    const sorted = numbers.slice(0).sort((a, b) => a - b);
    if (sorted.length % 2 === 0) {
      median = (sorted[(sorted.length >> 1) - 1] + sorted[sorted.length >> 1]) / 2;
    } else {
      median = sorted[sorted.length >> 1];
    }
    return [mean, median];
  }

}

/** Provides data about a label with sublabels (induced label hierarchy). */
export interface LabelGroup {
  parentName: string;
  children: string[];
  shouldCollapse: boolean;
}

interface BilledTransaction {
  source: Transaction;
  relevantLabels: string[];
  amount: number;
}

export interface BucketInfo {
  name: string;
  numTransactions: number;
  totalPositive: number;
  totalNegative: number;
}
