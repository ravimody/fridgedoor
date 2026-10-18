import FridgedoorKit
import SwiftUI

/// Eyebrow date, serif greeting and a one-line glance at the day.
struct HomeHeader: View {
    let member: Member
    let now: Date
    let decisionCount: Int
    let scheduleCount: Int
    let nextUp: AgendaEntry?
    let isLoaded: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Eyebrow(now.formatted(Date.FormatStyle(timeZone: member.timeZone).weekday(.wide).month(.wide).day()), color: .muted)
            Text("\(greeting), \(member.firstName)")
                .font(.serif(.largeTitle))
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if isLoaded {
                glance
                    .font(.subheadline)
                    .foregroundStyle(Color.muted)
                    .contentTransition(.numericText())
                    .animation(.snappy, value: decisionCount)
                    .animation(.snappy, value: scheduleCount)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var greeting: String {
        let hour = PlannerDates.calendar(member.timeZone).component(.hour, from: now)
        return switch hour {
        case 4..<12: "Good morning"
        case 12..<17: "Good afternoon"
        default: "Good evening"
        }
    }

    /// "2 decisions · Dinner with the Okafors at 7:00 PM" — what needs you, then what's next.
    private var glance: Text {
        let next: String
        if let nextUp, case let .timed(start, end, _) = nextUp.time, let date = PlannerDates.instant(start), let until = PlannerDates.instant(end) {
            next = date <= now
                ? "\(nextUp.title) until \(TimeLabels.time(until, in: member.timeZone))"
                : "\(nextUp.title) at \(TimeLabels.time(date, in: member.timeZone))"
        } else {
            next = scheduleCount == 0 ? "Nothing on the schedule today" : "Nothing else scheduled today"
        }
        guard decisionCount > 0 else { return Text(next) }
        let need = Text("\(decisionCount) decision\(decisionCount == 1 ? "" : "s")").foregroundStyle(Color.attentionInk).fontWeight(.semibold)
        return Text("\(need) · \(next)")
    }
}

/// Seven days starting today, in the member's timezone. Dots show how full each day
/// is (one to three). At accessibility text sizes the days scroll instead of squeezing.
struct DayPicker: View {
    let days: [Date]
    let today: Date
    @Binding var selection: Date
    let dayLoad: [Date: Int]
    let zone: TimeZone
    @Namespace private var namespace
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        Group {
            if typeSize.isAccessibilitySize {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) { dayButtons(width: 96) }
                }
                .scrollClipDisabled()
            } else {
                HStack(spacing: 4) { dayButtons(width: nil) }
            }
        }
        .sensoryFeedback(.selection, trigger: selection)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Choose a day")
    }

    private func dayButtons(width: CGFloat?) -> some View {
        ForEach(days, id: \.self) { day in
            let selected = day == selection
            Button {
                withAnimation(.snappy(duration: 0.3)) { selection = day }
            } label: {
                VStack(spacing: 6) {
                    Text(day.formatted(Date.FormatStyle(timeZone: zone).weekday(.abbreviated)).uppercased())
                        .font(.caption2.weight(.semibold))
                        .tracking(0.6)
                        .lineLimit(1)
                    Text(day.formatted(Date.FormatStyle(timeZone: zone).day()))
                        .font(.system(.title3, design: .serif).weight(selected || day == today ? .semibold : .regular))
                        .monospacedDigit()
                        .lineLimit(1)
                    HStack(spacing: 2) {
                        ForEach(0..<3, id: \.self) { index in
                            Circle().frame(width: 4, height: 4).opacity(index < dots(for: day) ? 1 : 0)
                        }
                    }
                }
                .foregroundStyle(selected ? Color.onAccent : day == today ? Color.plannerAccent : Color.muted)
                .padding(.vertical, 8)
                .frame(minWidth: width, maxWidth: width == nil ? .infinity : nil, minHeight: 72)
                .background {
                    if selected {
                        Capsule().fill(Color.plannerAccent).matchedGeometryEffect(id: "selected-day", in: namespace)
                    } else if day == today {
                        Capsule().strokeBorder(Color.plannerAccent.opacity(0.35), lineWidth: 1)
                    }
                }
                .contentShape(.capsule)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(accessibilityLabel(day))
            .accessibilityAddTraits(selected ? .isSelected : [])
        }
    }

    /// 1–2 things: one dot; 3–4: two; 5 or more: three.
    private func dots(for day: Date) -> Int {
        let load = dayLoad[day] ?? 0
        return load == 0 ? 0 : min(3, (load + 1) / 2)
    }

    private func accessibilityLabel(_ day: Date) -> String {
        let name = day == today ? "Today, " : ""
        let date = day.formatted(Date.FormatStyle(timeZone: zone).weekday(.wide).month(.wide).day())
        let load = dayLoad[day] ?? 0
        return name + date + (load == 0 ? ", nothing scheduled" : load == 1 ? ", 1 thing scheduled" : ", \(load) things scheduled")
    }
}
